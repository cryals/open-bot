import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import type { ActivityService } from './activity.js';
import { ModerationService } from './modules/moderation/service.js';
import { ModerationLogService } from './modules/moderation-logs/service.js';
import { HttpError } from './errors.js';
export function moderationRoutes(
  app: FastifyInstance,
  config: Config,
  store: Store,
  discord: DiscordPort,
  activity: ActivityService,
) {
  const service = new ModerationService(config, store, discord, activity),
    logs = new ModerationLogService(config, store, discord);
  const manage = (access: { moderationManage?: boolean }) => {
    if (!access.moderationManage) throw new HttpError(403, 'Нужно полномочие управления модерацией');
  };
  app.get('/api/moderation', async (request) => {
    const query = z
      .object({
        target: z
          .string()
          .regex(/^\d{17,20}$/)
          .optional(),
        before: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    return { cases: service.list(query.target, query.before) };
  });
  app.get('/api/moderation/guild', async () => discord.info());
  app.get('/api/moderation/settings', async (request) => {
    manage(request.adminAccess);
    return {
      moderation: service.settings(),
      logs: logs.settings(),
      delivery: store.sqlite.prepare('SELECT * FROM moderation_delivery ORDER BY rowid DESC LIMIT 100').all(),
    };
  });
  app.put('/api/moderation/settings', async (request) => {
    manage(request.adminAccess);
    const input = z.object({ document: z.unknown(), version: z.number().int().min(0) }).parse(request.body);
    return service.save(input.document, input.version, request.adminSession!);
  });
  app.put('/api/moderation/logs', async (request) => {
    manage(request.adminAccess);
    const input = z.object({ document: z.unknown(), version: z.number().int().min(0) }).parse(request.body);
    const before = logs.settings();
    const result = await logs.save(input.document, input.version);
    activity.record(request.adminSession!, {
      kind: 'moderation-log.settings',
      target: 'moderation-logs',
      summary: 'Изменён журнал наказаний',
      before: before.document,
      after: result.document,
    });
    return result;
  });
  app.post('/api/moderation/prepare', async (request) => {
    manage(request.adminAccess);
    return service.prepare(request.body, request.adminSession!);
  });
  app.post('/api/moderation/warnings/clear', async (request) => {
    manage(request.adminAccess);
    const input = z
      .object({ target: z.string().regex(/^\d{17,20}$/), reason: z.string().min(1).max(1000) })
      .parse(request.body);
    return service.clearWarnings(input.target, request.adminSession!, input.reason);
  });
  const id = (params: unknown) => z.object({ id: z.coerce.number().int().positive() }).parse(params).id;
  app.get('/api/moderation/:id', async (request) => ({
    case: service.get(id(request.params)),
    history: service.history(id(request.params)),
  }));
  app.post('/api/moderation/:id/duration', async (request) => {
    manage(request.adminAccess);
    const input = z
      .object({
        duration: z.number().int().min(1).max(315360000).nullable(),
        reason: z.string().min(1).max(1000),
      })
      .parse(request.body);
    return service.reviseDuration(id(request.params), request.adminSession!, input.duration, input.reason);
  });
  app.post('/api/moderation/:id/confirm', async (request) => {
    manage(request.adminAccess);
    return service.confirm(id(request.params), request.adminSession!.userId);
  });
  app.post('/api/moderation/:id/cancel', async (request) => {
    manage(request.adminAccess);
    service.cancel(id(request.params), request.adminSession!.userId);
    return { ok: true };
  });
  app.put('/api/moderation/:id', async (request) => {
    manage(request.adminAccess);
    const input = z
      .object({
        reason: z.string().trim().min(1).max(1000),
        revision: z.number().int().min(1),
        revoke: z.boolean().optional(),
      })
      .parse(request.body);
    return service.change(id(request.params), request.adminSession!, input);
  });
  app.post('/api/moderation/:id/resolve', async (request) => {
    manage(request.adminAccess);
    const input = z
      .object({ state: z.enum(['applied', 'failed']), reason: z.string().trim().min(1).max(1000) })
      .parse(request.body);
    return service.resolve(id(request.params), request.adminSession!, input.state, input.reason);
  });
}
