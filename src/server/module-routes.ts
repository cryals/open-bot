import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import type { ActivityService } from './activity.js';
import { ServerStatusService } from './modules/game-server-status/service.js';
import { WatchdogService } from './modules/watchdog/service.js';
import { TicketService } from './modules/ticket/service.js';
import { moduleId, snowflakeId, powerActionSchema } from '../shared/modules.js';
import { HttpError } from './errors.js';
import { restPort } from './module-http.js';
import type { ErrorReporter } from './runtime/error-reporter.js';
import { uiEventSchema } from '../shared/activity.js';
import { ApplicationSettingsStore } from './application-settings.js';
const versioned = z.object({ document: z.unknown(), version: z.number().int().min(0) });
const actor = (request: FastifyRequest) => request.adminSession!;
const ticketManager = (request: FastifyRequest) => {
  if (!request.adminAccess.ticketManage) throw new HttpError(403, 'Нужна полная роль Ticket');
};
export async function moduleRoutes(
  app: FastifyInstance,
  config: Config,
  store: Store,
  discord: DiscordPort,
  activity: ActivityService,
  errors?: ErrorReporter,
) {
  const servers = new ServerStatusService(config, store, discord, (error, scope) =>
      errors?.report(error, scope),
    ),
    watchdog = new WatchdogService(config, store, activity, (error, scope) => errors?.report(error, scope)),
    tickets = new TicketService(config, store, discord, activity, (error, scope) =>
      errors?.report(error, scope),
    );
  app.post(
    '/api/tickets/activity',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      const { events } = z.object({ events: z.array(uiEventSchema).min(1).max(20) }).parse(request.body);
      for (const event of events)
        activity.record(actor(request), {
          ...event,
          target: 'ticket-ui:' + event.target,
          details: { source: 'browser', context: event.context, occurredAt: event.occurredAt },
        });
      return { ok: true };
    },
  );
  app.get('/api/modules', async () => ({
    servers: servers.settings(),
    watches: servers.watches(),
    watchdog: watchdog.settings(),
    operations: watchdog.history(),
    gameServerHosts: new ApplicationSettingsStore(store, config).get().document.gameServerHosts,
    watchdogHosts: new ApplicationSettingsStore(store, config).get().document.watchdogHosts,
    tokenNames: Object.keys(process.env).filter((key) => /^WATCHDOG_TOKEN_[A-Z0-9_]+$/.test(key)),
    serverTokenNames: Object.keys(process.env).filter((key) => /^GAME_SERVER_TOKEN_[A-Z0-9_]+$/.test(key)),
    metrics: {
      enabled: config.metricsEnabled || false,
      host: config.metricsHost || '127.0.0.1',
      port: config.metricsPort || 9091,
    },
  }));
  app.put('/api/modules/servers', async (request) => {
    const input = versioned.parse(request.body),
      before = servers.settings();
    const result = servers.save(input.document, input.version);
    activity.record(actor(request), {
      kind: 'servers.settings',
      target: 'game-servers',
      summary: 'Изменены игровые серверы',
      before: before.document,
      after: result.document,
    });
    return result;
  });
  app.get('/api/modules/servers/:id', async (request) => {
    const { id } = z.object({ id: moduleId }).parse(request.params);
    return servers.get(id);
  });
  app.post('/api/modules/watches', async (request) => {
    const input = z.object({ serverId: moduleId, channelId: snowflakeId }).parse(request.body);
    const result = await servers.addWatch(input.serverId, input.channelId);
    activity.record(actor(request), {
      kind: 'servers.watch',
      target: input.serverId,
      summary: 'Добавлено наблюдение статуса',
      details: input,
    });
    return result;
  });
  app.delete('/api/modules/watches/:id', async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    servers.removeWatch(id);
    activity.record(actor(request), {
      kind: 'servers.unwatch',
      target: String(id),
      summary: 'Остановлено наблюдение',
    });
    return { ok: true };
  });
  app.put('/api/modules/watchdog', async (request) => {
    const input = versioned.parse(request.body),
      before = watchdog.settings();
    const result = watchdog.save(input.document, input.version);
    activity.record(actor(request), {
      kind: 'watchdog.settings',
      target: 'watchdog',
      summary: 'Изменены настройки Watchdog',
      before: before.document,
      after: result.document,
    });
    return result;
  });
  app.get('/api/modules/watchdog/:id/versions', async (request) => {
    const { id } = z.object({ id: moduleId }).parse(request.params);
    return watchdog.versions(id);
  });
  app.post('/api/modules/watchdog/prepare', async (request) => {
    const input = z
      .object({
        serverId: moduleId,
        action: powerActionSchema,
        version: z.string().max(120).optional(),
        immediate: z.boolean().default(false),
      })
      .parse(request.body);
    return watchdog.prepare(
      actor(request).userId,
      input.serverId,
      input.action,
      input.version,
      input.immediate,
    );
  });
  app.post('/api/modules/watchdog/network', async (request) => watchdog.prepareBatch(actor(request).userId));
  app.post('/api/modules/watchdog/network/:id/confirm', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return watchdog.confirmBatch(id, actor(request));
  });
  app.post('/api/modules/watchdog/network/:id/cancel', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    watchdog.cancelBatch(id, actor(request).userId);
    return { ok: true };
  });
  app.post('/api/modules/watchdog/:id/confirm', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return watchdog.confirm(id, actor(request));
  });
  app.post('/api/modules/watchdog/:id/cancel', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    watchdog.cancel(id, actor(request).userId);
    return { ok: true };
  });
  app.post('/api/modules/watchdog/:id/resolve', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    watchdog.resolve(id, actor(request));
    return { ok: true };
  });
  app.get('/api/tickets/settings', async (request) => {
    ticketManager(request);
    return {
      ...tickets.tickets.config(),
      panels: tickets.tickets.panels(),
      gatewayEnabled: tickets.gatewayAvailable(),
    };
  });
  app.put('/api/tickets/settings', async (request) => {
    ticketManager(request);
    const input = versioned.parse(request.body);
    return tickets.saveConfig(input.document, input.version, actor(request));
  });
  app.get('/api/tickets/guild', async (request) => {
    ticketManager(request);
    const rest = restPort(discord);
    const [channels, roles] = await Promise.all([
      rest.get(`/guilds/${config.guildId}/channels`),
      rest.get(`/guilds/${config.guildId}/roles`),
    ]);
    return { channels, roles };
  });
  app.get('/api/tickets', async (request) => {
    const filters = z
      .object({
        state: z.string().max(20).optional(),
        category: moduleId.optional(),
        author: snowflakeId.optional(),
        assignee: snowflakeId.optional(),
        search: z.string().max(100).optional(),
        before: z.coerce.number().int().positive().optional(),
        from: z.coerce.number().int().positive().optional(),
        to: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    const result = tickets.tickets.list(filters);
    return {
      tickets: result.slice(0, 50).map((ticket) => ({
        ...ticket,
        thread_id: ticket.author_id === actor(request).userId ? null : ticket.thread_id,
      })),
      nextBefore: result.length > 50 ? result[49].id : null,
    };
  });
  app.get('/api/tickets/:id', async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const ticket = tickets.tickets.get(id);
    const staff = ticket.author_id !== actor(request).userId;
    return {
      ticket: { ...ticket, thread_id: staff ? ticket.thread_id : null },
      canViewStaff: staff,
      events: store.sqlite
        .prepare('SELECT * FROM ticket_events WHERE ticket_id=? ORDER BY id DESC LIMIT 500')
        .all(id),
      jobs: request.adminAccess.ticketManage
        ? store.sqlite
            .prepare('SELECT id,action,value,error,state FROM ticket_jobs WHERE ticket_id=?')
            .all(id)
        : [],
    };
  });
  app.delete('/api/tickets/:id/jobs/:job', async (request) => {
    ticketManager(request);
    const { id, job } = z
      .object({ id: z.coerce.number().int().positive(), job: z.coerce.number().int().positive() })
      .parse(request.params);
    tickets.tickets.get(id);
    if (
      !store.sqlite
        .prepare("DELETE FROM ticket_jobs WHERE id=? AND ticket_id=? AND state='pending'")
        .run(job, id).changes
    )
      throw new HttpError(409, 'Задание выполняется или уже завершено');
    tickets.tickets.event(id, actor(request).userId, 'change.cancel', 'Отменено задание ' + job);
    return { ok: true };
  });
  const scopeAccess = (request: FastifyRequest, id: number, scope: string) => {
    const ticket = tickets.tickets.get(id);
    if (scope === 'staff' && ticket.author_id === actor(request).userId)
      throw new HttpError(403, 'Автор не видит служебное обсуждение');
    return ticket;
  };
  app.get('/api/tickets/:id/messages', async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const { scope, before } = z
      .object({ scope: z.enum(['customer', 'staff']).default('customer'), before: snowflakeId.optional() })
      .parse(request.query);
    scopeAccess(request, id, scope);
    return { messages: tickets.archive.messages(id, scope, before) };
  });
  app.get('/api/tickets/files/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { preview } = z.object({ preview: z.literal('1').optional() }).parse(request.query);
    const file = store.sqlite.prepare('SELECT ticket_id,scope FROM ticket_files WHERE id=?').get(id) as
      { ticket_id: number; scope: string } | undefined;
    if (!file) throw new HttpError(404, 'Файл не найден');
    scopeAccess(request, file.ticket_id, file.scope);
    const { file: record, buffer } = await tickets.archive.download(id);
    if (preview && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(record.mime))
      throw new HttpError(400, 'Этот файл нельзя показывать как изображение');
    reply
      .header(
        'Content-Disposition',
        (preview ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(record.name),
      )
      .type(preview ? record.mime : 'application/octet-stream');
    return reply.send(buffer);
  });
  app.post('/api/tickets/publish', async (request) => {
    ticketManager(request);
    const { channelId } = z.object({ channelId: snowflakeId }).parse(request.body);
    return { id: await tickets.publish(channelId, actor(request)) };
  });
  app.post('/api/tickets/:id/action', async (request) => {
    ticketManager(request);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const { action, value, confirmed } = z
      .object({
        action: z.enum(['claim', 'waiting', 'close', 'add', 'remove', 'category']),
        value: z.string().max(1000).default(''),
        confirmed: z.boolean().default(false),
      })
      .parse(request.body);
    if (action === 'close' && !confirmed) throw new HttpError(400, 'Подтвердите закрытие');
    return tickets.change(id, actor(request), action, value);
  });
}
