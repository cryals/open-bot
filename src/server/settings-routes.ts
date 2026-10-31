import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applicationSettingsSchema } from '../shared/settings.js';
import type { Store } from './store.js';
import type { Config } from './config.js';
import type { DiscordPort } from './discord.js';
import type { ActivityService } from './activity.js';
import { ApplicationSettingsStore } from './application-settings.js';
import { HttpError } from './errors.js';

export function settingsRoutes(
  app: FastifyInstance,
  store: Store,
  config: Config,
  discord: DiscordPort,
  activity: ActivityService,
) {
  const settings = new ApplicationSettingsStore(store, config);
  app.get('/api/settings/application', async () => {
    const saved = settings.get(),
      applied = settings.appliedGateway();
    return {
      ...saved,
      appliedGateway: applied,
      restartRequired: JSON.stringify(applied) !== JSON.stringify(saved.document.gateway),
      restartAvailable: !!process.send,
      metricsReady: (config.metricsToken?.length || 0) >= 32,
      metricsPort: config.metricsPort || 9091,
    };
  });
  app.put('/api/settings/application', async (request) => {
    const input = z
      .object({ document: applicationSettingsSchema, version: z.number().int().min(0) })
      .parse(request.body);
    if (input.document.metricsEnabled && (config.metricsToken?.length || 0) < 32)
      throw new HttpError(400, 'Сначала задайте технический секрет METRICS_TOKEN в ENV (минимум 32 символа)');
    if (input.document.metricsEnabled && config.metricsPort === config.port)
      throw new HttpError(400, 'Порты Web и Metrics должны различаться');
    const guild = await discord.info();
    for (const roles of Object.values(input.document.grants))
      for (const role of roles)
        if (!guild.roles.some((item) => item.id === role))
          throw new HttpError(400, 'Роль доступа отсутствует на сервере');
    if (
      input.document.errorChannelId &&
      !guild.channels.some((item) => item.id === input.document.errorChannelId)
    )
      throw new HttpError(400, 'Канал ошибок отсутствует на сервере');
    const before = settings.get();
    const after = store.sqlite
      .transaction(() => {
        const saved = settings.save(input.document, input.version);
        if (before.document.monitoring.refreshSeconds !== saved.document.monitoring.refreshSeconds)
          store.sqlite.prepare('UPDATE server_watches SET next_at=0 WHERE enabled=1').run();
        return saved;
      })
      .immediate();
    settings.applyLive();
    activity.record(request.adminSession!, {
      kind: 'settings.application',
      target: 'application',
      summary: 'Изменены настройки приложения',
      before: before.document,
      after: after.document,
    });
    return after;
  });
  app.post('/api/settings/restart-bot', async (request) => {
    if (!process.send)
      throw new HttpError(409, 'Контролируемый перезапуск доступен при запуске через supervisor');
    if (
      store.sqlite.prepare("SELECT 1 FROM power_operations WHERE state='running' LIMIT 1").get() ||
      store.sqlite.prepare("SELECT 1 FROM tickets WHERE state='closing' LIMIT 1").get() ||
      store.sqlite.prepare("SELECT 1 FROM core_jobs WHERE state='running' LIMIT 1").get() ||
      store.sqlite.prepare('SELECT 1 FROM runtime_locks WHERE expires_at>? LIMIT 1').get(Date.now())
    )
      throw new HttpError(409, 'Дождитесь завершения текущих операций');
    store.sqlite.prepare('UPDATE core_controls SET restart_bot=restart_bot+1 WHERE id=1').run();
    activity.record(request.adminSession!, {
      kind: 'runtime.restart',
      target: 'bot',
      summary: 'Запрошен перезапуск Bot из панели',
    });
    return { ok: true };
  });
}
