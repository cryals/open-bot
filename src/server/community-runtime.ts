import type { BotContext } from './runtime/types.js';
import { CommunityStore } from './community-store.js';
import { TtlCounters } from './ttl-counters.js';
import { JobStore } from './jobs.js';
import { MessagePolicyService, completeMessage } from './modules/automod/service.js';
import { JoinPolicyService } from './modules/anti-raid/service.js';
import { RoleMenuService } from './modules/role-menus/service.js';
import { FormService } from './modules/forms/service.js';
import { GiveawayService } from './modules/giveaways/service.js';
import { CustomCommandService } from './modules/custom-commands/service.js';
import { StarboardService } from './modules/starboard/service.js';
import { FeedService } from './modules/subscriptions/service.js';
import { GuildBackupService } from './modules/guild-backup/service.js';
import { restPort } from './module-http.js';
import { telemetry } from './telemetry.js';
import { HttpError } from './errors.js';
import { communityDefinitions, communityJobModules } from '../shared/community.js';
import { requireCapability } from './access.js';
import { saveCommunityConfiguration } from './community-config.js';
const runtimes = new WeakMap<object, CommunityRuntime>();
export function community(context: BotContext) {
  let runtime = runtimes.get(context.store);
  if (!runtime) {
    runtime = new CommunityRuntime(context);
    runtimes.set(context.store, runtime);
  }
  return runtime;
}
export class CommunityRuntime {
  readonly configs: CommunityStore;
  readonly counters: TtlCounters;
  readonly policies: MessagePolicyService;
  readonly joins: JoinPolicyService;
  readonly roles: RoleMenuService;
  readonly forms: FormService;
  readonly giveaways: GiveawayService;
  readonly custom: CustomCommandService;
  readonly starboard: StarboardService;
  readonly feeds: FeedService;
  readonly backup: GuildBackupService;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private rawHandler?: (event: { t?: string; d?: Record<string, unknown> }) => void;
  private pending = 0;
  private tail = Promise.resolve();
  private customVersion = -1;
  private customRetryAt = 0;
  private active = new Map<string, Promise<void>>();
  private lastMaintenance = 0;
  private maintenanceCursor = 0;
  private overloadReportedAt = 0;
  constructor(readonly context: BotContext) {
    this.configs = new CommunityStore(context.store);
    this.counters = new TtlCounters(context.config, (error, scope) => context.errors.report(error, scope));
    this.policies = new MessagePolicyService(context, this.counters);
    this.joins = new JoinPolicyService(context, this.counters);
    this.roles = new RoleMenuService(context);
    this.forms = new FormService(context);
    this.giveaways = new GiveawayService(context);
    this.custom = new CustomCommandService(context, this.counters);
    this.starboard = new StarboardService(context);
    this.feeds = new FeedService(context);
    this.backup = new GuildBackupService(context);
  }
  async start() {
    await this.counters.start();
    this.rawHandler = (event) => {
      if (this.stopped || event.d?.guild_id !== this.context.config.guildId) return;
      if (this.pending >= 250) {
        if (Date.now() - this.overloadReportedAt >= 60000) {
          this.overloadReportedAt = Date.now();
          this.context.errors.report(
            new Error('Community event queue limit reached; further reports suppressed for 60s'),
            'community.overload',
          );
        }
        return;
      }
      this.pending++;
      this.tail = this.tail
        .then(() => this.raw(event))
        .catch((error) => this.context.errors.report(error, 'community.gateway'))
        .then(() => {
          this.pending--;
        });
    };
    this.context.discord.client.on('raw', this.rawHandler);
    this.timer = setInterval(
      () => void this.tick().catch((error) => this.context.errors.report(error, 'community.tick')),
      1000,
    );
    this.timer.unref();
  }
  private async raw(event: { t?: string; d?: Record<string, unknown> }) {
    const data = event.d!;
    if (['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(event.t || '')) {
      const enabled = ['automod', 'autoresponder', 'slowmode'].some(
        (id) => this.configs.config(id as 'automod').document.enabled,
      );
      if (enabled && this.context.config.gateway?.messages && this.context.config.gateway.messageContent) {
        try {
          await this.policies.process(await completeMessage(this.context, data));
        } catch (error) {
          if ((error as { code?: number }).code !== 10008) throw error;
        }
      }
      await this.starboard.event(data);
    } else if (event.t === 'MESSAGE_DELETE') await this.starboard.event(data);
    else if (event.t === 'MESSAGE_DELETE_BULK')
      for (const id of (data.ids as string[]) || []) await this.starboard.event({ ...data, id });
    else if (event.t === 'GUILD_MEMBER_ADD') await this.joins.join(data);
    else if (event.t === 'MESSAGE_REACTION_ADD' || event.t === 'MESSAGE_REACTION_REMOVE') {
      await this.roles.reaction(data, event.t === 'MESSAGE_REACTION_ADD');
      await this.starboard.event(data);
    } else if (event.t === 'MESSAGE_REACTION_REMOVE_ALL' || event.t === 'MESSAGE_REACTION_REMOVE_EMOJI')
      await this.starboard.event(data);
    else if (event.t === 'AUTO_MODERATION_ACTION_EXECUTION') await this.policies.raw(data);
  }
  private async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const custom = this.configs.config('custom-commands');
      if (
        custom.version !== this.customVersion &&
        Date.now() >= this.customRetryAt &&
        this.context.manager.definitions().some((module) => module.id === 'custom-commands')
      ) {
        this.customRetryAt = Date.now() + 60000;
        this.launch('custom-commands', async () => {
          await this.context.manager.replaceDynamicCommands('custom-commands', this.custom.definitions());
          this.customVersion = custom.version;
          this.configs.set('custom-commands', 'registration', {
            state: 'ready',
            version: custom.version,
            time: Date.now(),
          });
        });
      }
      const jobs = new JobStore(this.context.store);
      const owner = communityJobModules;
      const groups: Record<string, string> = {
        ...owner,
        'community.join': 'anti-raid',
        'community.delete': 'message-expiry',
      };
      for (let index = 0; index < 4 && this.active.size < 8; index++) {
        const job = jobs.claim(Object.keys(groups).filter((kind) => !this.active.has(groups[kind])));
        if (!job) break;
        const data = JSON.parse(job.payload),
          started = Date.now();
        this.launch(groups[job.kind], async () => {
          try {
            const module = owner[job.kind];
            if (module && data.actor !== this.context.config.clientId) {
              if (typeof data.actor !== 'string')
                throw new HttpError(403, 'У задания отсутствует исполнитель');
              await requireCapability(
                this.context.discord,
                this.context.store,
                this.context.config,
                data.actor,
                communityDefinitions[module].capability,
              );
            }
            if (job.kind === 'community.join') await this.joins.process(data);
            else if (job.kind === 'community.delete')
              try {
                await restPort(this.context.discord).delete(`/channels/${data.channel}/messages/${data.id}`, {
                  signal: AbortSignal.timeout(10000),
                });
              } catch (error) {
                if ((error as { code?: number }).code !== 10008) throw error;
              }
            else if (job.kind === 'community.role-panel') await this.roles.publish(data.id);
            else if (job.kind === 'community.native-sync') await this.policies.syncNative();
            else if (job.kind === 'community.backup') await this.backup.snapshot(data.id);
            else if (job.kind === 'community.restore') await this.backup.executeRestore(data.id);
            else if (job.kind === 'community.raid-start') await this.joins.start(data.reason);
            else if (job.kind === 'community.raid-stop') await this.joins.stop(data.reason);
            else if (job.kind === 'community.giveaway-end' || job.kind === 'community.giveaway-reroll')
              await this.giveaways.end(data.id, data.actor, data.reason, job.kind.endsWith('reroll'));
            else if (job.kind === 'community.giveaway-cancel') this.giveaways.cancel(data.id, data.reason);
            else if (job.kind === 'community.star-hide') await this.starboard.hide(data.board, data.id);
            jobs.finish(job);
            this.context.activity.record(
              { userId: data.actor || this.context.config.clientId, name: data.actor || 'Open Bot' },
              {
                kind: 'community.result',
                target: job.kind,
                summary: 'Завершено задание модуля',
                details: { operationId: job.id, outcome: 'success' },
              },
            );
            telemetry.observe('community', job.kind, 'success', started);
          } catch (error) {
            jobs.fail(job, error instanceof Error ? error.message : 'Error');
            if (job.kind === 'community.backup')
              this.context.store.sqlite
                .prepare("UPDATE guild_backups SET state='failed',error=? WHERE id=? AND state<>'ready'")
                .run(error instanceof Error ? error.message : 'Error', data.id);
            if (job.kind === 'community.restore')
              this.context.store.sqlite
                .prepare(
                  "UPDATE guild_restores SET state='failed',error=? WHERE id=? AND state NOT IN ('unknown','cancelled','done')",
                )
                .run(error instanceof Error ? error.message : 'Error', data.id);
            this.context.errors.report(error, job.kind);
            telemetry.observe('community', job.kind, 'error', started);
          }
        });
      }
      if (Date.now() - this.lastMaintenance >= 10000) {
        this.lastMaintenance = Date.now();
        const maintenance = [
          ['anti-raid', () => this.joins.tick()],
          ['forms', () => this.forms.tick()],
          ['giveaways', () => this.giveaways.tick()],
          ['starboard', () => this.starboard.tick()],
          ['phishing-source', () => this.policies.refreshPhishing()],
          ['subscriptions', () => this.feeds.tick()],
          ['guild-backup', () => this.backup.tick()],
        ] as const;
        for (let index = 0; index < maintenance.length; index++) {
          const [scope, run] = maintenance[(this.maintenanceCursor + index) % maintenance.length];
          this.launch(scope, run);
        }
        this.maintenanceCursor = (this.maintenanceCursor + 1) % maintenance.length;
        this.context.store.sqlite.prepare('DELETE FROM automod_evidence WHERE expires_at<=?').run(Date.now());
        this.context.store.sqlite
          .prepare("DELETE FROM module_state WHERE module='autoban' AND updated_at<?")
          .run(Date.now() - 30 * 86400000);
        this.context.store.sqlite
          .prepare("DELETE FROM core_jobs WHERE state IN ('done','cancelled') AND created_at<?")
          .run(Date.now() - 30 * 86400000);
        this.context.store.sqlite
          .prepare(
            "DELETE FROM module_state WHERE module='role-menus' AND key LIKE 'interaction:%' AND updated_at<?",
          )
          .run(Date.now() - 30 * 86400000);
      }
    } finally {
      this.busy = false;
    }
  }
  private launch(scope: string, run: () => Promise<void>) {
    if (this.stopped || this.active.has(scope) || this.active.size >= 8) return;
    const task = Promise.resolve()
      .then(run)
      .catch((error) => {
        this.context.errors.report(error, scope + '.tick');
        if (scope === 'custom-commands')
          this.configs.set(scope, 'registration', {
            state: 'failed',
            error: error instanceof Error ? error.name : 'Error',
            time: Date.now(),
          });
      })
      .finally(() => this.active.delete(scope));
    this.active.set(scope, task);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.rawHandler) this.context.discord.client.off('raw', this.rawHandler);
    this.feeds.stop();
    await this.counters.stop();
  }
  async setEnabled(id: import('../shared/community.js').CommunityModuleId, enabled: boolean, actor: string) {
    const current = this.configs.config(id, true);
    return saveCommunityConfiguration(this.context, id, { ...current.document, enabled }, current.version, {
      userId: actor,
      name: actor,
    });
  }
}
