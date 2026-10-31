import { loadConfig } from '../config.js';
import { ErrorReporter } from './error-reporter.js';
import type { ModuleState, ProcessState, RuntimeStatus } from './types.js';
import type { Interaction } from 'discord.js';
import { telemetry } from '../telemetry.js';
import { secretValues } from '../module-http.js';
import { ApplicationSettingsStore } from '../application-settings.js';

const config = loadConfig();
const role = process.env.OS_WORKER_ROLE;
if (role !== 'bot' && role !== 'web' && role !== 'metrics')
  throw new Error('Worker must be started by the Core supervisor');
const errors = new ErrorReporter(config, role);
const empty = (): ProcessState => ({
  pid: null,
  state: 'starting',
  ready: false,
  restarts: 0,
  lastBeat: 0,
  modules: [],
});
let status: RuntimeStatus = { bot: empty(), web: empty() };
let state: 'starting' | 'running' = 'starting';
let ready = () => false;
let activityError: () => string | null = () => null;
let modules = (): ModuleState[] => [];
let cleanup = async () => {};
let stopping = false;
function sendHeartbeat() {
  for (const module of modules())
    telemetry.moduleUp.set({ module: module.id }, module.state === 'running' ? 1 : 0);
  const own = Object.entries(status).find(([worker]) => worker === role)?.[1];
  telemetry.restarts.set({ worker: role! }, own?.restarts || 0);
  if (process.connected)
    process.send?.(
      {
        type: 'heartbeat',
        state,
        ready: ready(),
        activityError: activityError(),
        modules: modules(),
        rss: process.memoryUsage().rss,
      },
      (error) => {
        if (error && !stopping) {
          errors.report(error, 'worker.heartbeat');
          void shutdown(1);
        }
      },
    );
}
const heartbeat = setInterval(sendHeartbeat, 5000);
heartbeat.unref();
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  telemetry.stop();
  const deadline = setTimeout(() => process.exit(code), 8000);
  deadline.unref();
  try {
    await cleanup();
  } catch (error) {
    errors.report(error, 'worker.shutdown', {}, true);
  }
  errors.stop();
  process.exit(code);
}
const fatal = (error: unknown, scope: string) => {
  errors.report(error, scope, {}, true);
  void shutdown(1);
};
process.on('uncaughtException', (error) => fatal(error, 'process.uncaughtException'));
process.on('unhandledRejection', (error) => fatal(error, 'process.unhandledRejection'));
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  if (message.type === 'status' && 'status' in message) status = message.status as RuntimeStatus;
  else if (message.type === 'shutdown') void shutdown(0);
});
process.once('disconnect', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
process.once('SIGINT', () => void shutdown(0));

try {
  const [{ Store }, { loadSeed }, { ActivityService }] = await Promise.all([
    import('../store.js'),
    import('../seed.js'),
    import('../activity.js'),
  ]);
  const store = new Store(config.databasePath, config.guildId, loadSeed(), config.adminRoleId);
  const settings = new ApplicationSettingsStore(store, config);
  settings.applyStartup();
  const logError = (error: unknown, scope: string) => {
    errors.report(error, scope);
  };
  const secrets = secretValues(config);
  let telemetryStarted = false;
  const refreshSettings = () => {
    settings.applyLive();
    if (config.metricsEnabled && !telemetryStarted) {
      telemetry.start(store, role, (error) => logError(error, 'metrics.snapshot'));
      telemetryStarted = true;
    } else if (!config.metricsEnabled && telemetryStarted) {
      telemetry.stop();
      telemetryStarted = false;
    }
  };
  refreshSettings();
  const settingsTimer = setInterval(() => {
    try {
      refreshSettings();
    } catch (error) {
      logError(error, 'settings.refresh');
    }
  }, 10000);
  settingsTimer.unref();
  if (role === 'bot') {
    const [{ DiscordService }, { ModuleManager }, { Publisher }, { botModules }, { Events }] =
      await Promise.all([
        import('../discord.js'),
        import('./module-manager.js'),
        import('../publisher.js'),
        import('../modules/catalog.js'),
        import('discord.js'),
      ]);
    const discord = new DiscordService(config, store, (error, scope) => logError(error, scope || 'gateway'));
    const activity = new ActivityService(store, discord, secrets, {
      onError: logError,
      redisUrl: config.redisUrl,
      redisKey: config.redisKey,
    });
    activityError = () => activity.deliveryError || activity.storageError;
    discord.setActivity(activity);
    const publisher = new Publisher(store, discord, activity, errors);
    const manager = new ModuleManager({
      config,
      store,
      discord,
      activity,
      publisher,
      errors,
      status: () => status,
    });
    modules = () => manager.list();
    ready = () => discord.isReady();
    const handler = (interaction: Interaction) => {
      void manager.dispatch(interaction).catch((error) => errors.report(error, 'interaction.dispatch'));
    };
    discord.client.on(Events.InteractionCreate, handler);
    let registrationNeeded = true;
    let repairBusy = false;
    const repair = async () => {
      if (repairBusy || stopping || !discord.isReady()) return;
      repairBusy = true;
      try {
        const failed = botModules.filter(
          (source) =>
            source.id !== 'core' &&
            manager.list().some((module) => module.id === source.id && module.state === 'failed'),
        );
        if (failed.length) {
          await manager.load(failed);
          registrationNeeded = true;
        }
        if (registrationNeeded) {
          await manager.registerCommands();
          registrationNeeded = false;
        }
      } catch (error) {
        errors.report(error, 'core.command-registration');
      } finally {
        repairBusy = false;
      }
    };
    const repairTimer = setInterval(() => void repair(), 60000);
    repairTimer.unref();
    cleanup = async () => {
      clearInterval(repairTimer);
      discord.client.off(Events.InteractionCreate, handler);
      await manager.stop();
      await activity.close();
      store.close();
    };
    await manager.load(botModules);
    if (manager.list().find((module) => module.id === 'core')?.state !== 'running')
      throw new Error('Core module failed to initialize');
    settings.markGatewayApplied();
    state = 'running';
    sendHeartbeat();
    await repair();
  } else if (role === 'web') {
    const [{ DiscordRest }, { WebModule }] = await Promise.all([
      import('../discord-rest.js'),
      import('../modules/web/index.js'),
    ]);
    const discord = new DiscordRest(config, store, () => status.bot.ready);
    const activity = new ActivityService(store, discord, secrets, {
      deliver: false,
      consume: false,
      onError: logError,
    });
    const web = new WebModule(config, store, activity, discord, errors, () => status);
    modules = () => [{ id: 'web', title: 'Web', state: state === 'running' ? 'running' : 'starting' }];
    cleanup = async () => {
      await web.stop();
      await activity.close();
      store.close();
    };
    await web.start();
    ready = () => true;
    state = 'running';
    sendHeartbeat();
  } else {
    const { MetricsExporter } = await import('../modules/metrics/exporter.js');
    const exporter = new MetricsExporter(config, store, (error) => errors.report(error, 'metrics.scrape'));
    cleanup = async () => {
      await exporter.stop();
      store.close();
    };
    await exporter.start();
    modules = () => [{ id: 'metrics', title: 'Metrics', state: 'running' }];
    ready = () => true;
    state = 'running';
    sendHeartbeat();
  }
  console.info(JSON.stringify({ kind: 'worker.ready', role, pid: process.pid }));
} catch (error) {
  fatal(error, 'worker.bootstrap');
}
