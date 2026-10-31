import Fastify, { LogController, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { documentSchema, settingsSchema } from '../shared/rules.js';
import type { Config } from './config.js';
import type { DiscordPort } from './discord.js';
import type { OAuthPort } from './oauth.js';
import type { Store } from './store.js';
import { HttpError } from './errors.js';
import { composerRoutes } from './composer-routes.js';
import { ActivityService } from './activity.js';
import { Publisher } from './publisher.js';
import { ErrorReporter } from './runtime/error-reporter.js';
import { uiEventSchema } from '../shared/activity.js';
import type { Access } from '../shared/modules.js';
import { initialTicketConfig, ticketConfigSchema } from '../shared/modules.js';
import { permissions } from './access.js';
import { ModuleStore } from './module-store.js';
import { moduleRoutes } from './module-routes.js';
import { secretValues } from './module-http.js';
import { telemetry } from './telemetry.js';
import { settingsRoutes } from './settings-routes.js';
import { hasPanelAccess } from '../shared/modules.js';
import { moderationRoutes } from './moderation-routes.js';
import { communityRoutes } from './community-routes.js';
import { integrationRoutes } from './integration-routes.js';
import { FormService } from './modules/forms/service.js';
declare module 'fastify' {
  interface FastifyRequest {
    adminSession: NonNullable<ReturnType<Store['session']>> | null;
    adminAccess: Access;
  }
}

const equal = (a: string, b: string) => {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};
const versionSchema = z.object({ version: z.number().int().positive() });

export async function createApp(options: {
  config: Config;
  store: Store;
  discord: DiscordPort;
  oauth: OAuthPort;
  logger?: boolean;
  activity?: ActivityService;
  errors?: ErrorReporter;
  runtime?: () => unknown;
  activityDeliveryError?: () => string | null;
}) {
  const { config, store, discord, oauth } = options;
  const app = Fastify({
    logger: options.logger ?? true,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  await app.register(cookie);
  app.decorateRequest('adminSession', null);
  app.decorateRequest('adminAccess');
  const activity =
    options.activity ||
    new ActivityService(store, discord, secretValues(config), {
      redisUrl: config.redisUrl,
      redisKey: config.redisKey,
    });
  const publisher = new Publisher(store, discord, activity, options.errors);
  discord.setActivity?.(activity);
  app.addHook('onClose', async () => {
    activity.record(
      { userId: config.clientId, name: 'Open Bot' },
      { kind: 'system.stop', target: 'server', summary: 'Сервис остановлен' },
    );
    if (!options.activity) await activity.close();
  });
  const actor = (request: FastifyRequest) => request.adminSession!;
  activity.record(
    { userId: config.clientId, name: 'Open Bot' },
    { kind: 'system.start', target: 'server', summary: 'Сервис запущен' },
  );
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url || 'unknown';
    telemetry.http.inc({ method: request.method, route, status: String(reply.statusCode) });
    telemetry.httpDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
    if (!route.startsWith('/api/') || route.startsWith('/api/activity') || route === '/api/health') return;
    activity.record(request.adminSession || { userId: 'guest', name: 'Гость' }, {
      kind: reply.statusCode >= 400 ? 'api.error' : 'api.request',
      target: request.method + ' ' + route,
      summary: `Запрос ${request.method} ${route}: ${reply.statusCode}`,
      details: {
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        params: request.params,
      },
    });
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.secureCookies ? [] : null,
      },
    },
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: config.secureCookies, path: '/' };
  const assertNotPublishing = () => publisher.assertIdle();
  async function authenticate(request: FastifyRequest) {
    const session = store.session(request.cookies.os_session || '');
    if (!session) throw new HttpError(401, 'Войдите через Discord');
    const access = await permissions(discord, store, config, session.userId);
    if (!hasPanelAccess(access)) {
      activity.record(session, {
        kind: 'auth.denied',
        target: 'admin',
        summary: 'Доступ к панели отклонён: недостаточно прав',
      });
      store.deleteSession(request.cookies.os_session || '');
      throw new HttpError(403, 'У вас нет роли администратора для этой панели');
    }
    request.adminAccess = access;
    return session;
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/auth/'))
      reply.header('Cache-Control', 'no-store');
    if (request.url.startsWith('/api/') && request.url.split('?')[0] !== '/api/health') {
      const applicant = request.url.startsWith('/api/applicant/');
      const session = applicant
        ? store.session(request.cookies.os_session || '')
        : await authenticate(request);
      if (!session) throw new HttpError(401, 'Войдите через Discord');
      request.adminSession = session;
      const path = request.url.split('?')[0];
      const ticket = path === '/api/tickets' || path.startsWith('/api/tickets/');
      const common = ['/api/me', '/api/logout'].includes(path);
      const media = path === '/api/media' || path.startsWith('/api/media/');
      const moderation = path === '/api/moderation' || path.startsWith('/api/moderation/');
      const community = path === '/api/community' || path.startsWith('/api/community/');
      if (
        !applicant &&
        !common &&
        !(community
          ? hasPanelAccess(request.adminAccess)
          : moderation
            ? request.adminAccess.moderationView || request.adminAccess.moderationManage
            : ticket
              ? request.adminAccess.ticketView
              : media
                ? request.adminAccess.ticketManage ||
                  request.adminAccess.rolesManage ||
                  request.adminAccess.formsManage ||
                  request.adminAccess.feedsManage
                : request.adminAccess.admin)
      )
        throw new HttpError(403, 'Нет доступа к этому разделу');
      if (media && !request.adminAccess.admin && request.method === 'GET') {
        const id = path.split('/').at(-1)!;
        const record = store.sqlite.prepare('SELECT actor FROM media WHERE id=?').get(id) as
          { actor: string } | undefined;
        const ticketConfig = new ModuleStore(store).get(
          'tickets',
          ticketConfigSchema,
          initialTicketConfig,
        ).document;
        if (record?.actor !== session.userId && !JSON.stringify(ticketConfig).includes('/api/media/' + id))
          throw new HttpError(403, 'Нет доступа к файлу');
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        if (
          request.headers.origin !== config.appOrigin ||
          typeof request.headers['x-csrf-token'] !== 'string' ||
          !equal(session.csrf, request.headers['x-csrf-token'])
        ) {
          throw new HttpError(403, 'Проверка безопасности не пройдена. Обновите страницу.');
        }
      }
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply
        .code(400)
        .send({ error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n') });
    }
    if (error instanceof HttpError) {
      if (error.statusCode >= 500)
        options.errors?.report(error, 'web.request', {
          method: request.method,
          route: request.routeOptions.url,
          actor: request.adminSession?.userId,
        });
      return reply.code(error.statusCode).send({ error: error.message });
    }
    const known = error instanceof Error ? error : new Error('Unknown error');
    const code = 'code' in known ? String(known.code) : undefined;
    const statusCode = 'statusCode' in known ? Number(known.statusCode) : 500;
    const status = statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    // Deliberately omit request URLs, headers, bodies and OAuth query parameters.
    app.log.error({ name: known.name, code }, 'Request failed');
    const errorId =
      status === 500
        ? options.errors?.report(known, 'web.request', {
            method: request.method,
            route: request.routeOptions.url,
            actor: request.adminSession?.userId,
          })
        : undefined;
    return reply.code(status).send({
      error:
        status === 500
          ? 'Не удалось выполнить действие. Проверьте журнал сервера.' + (errorId ? ' ID: ' + errorId : '')
          : 'Некорректный запрос',
    });
  });
  app.get('/api/health', async (_request, reply) => {
    if (!discord.isReady()) reply.code(503);
    return { status: discord.isReady() ? 'ok' : 'discord-offline' };
  });
  app.get(
    '/auth/discord',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const state = store.createOAuthState();
      const query = z
        .object({
          form: z
            .string()
            .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
            .optional(),
        })
        .parse(request.query);
      if (query.form) reply.setCookie('ob_form_return', query.form, { ...cookieOptions, maxAge: 600 });
      else reply.clearCookie('ob_form_return', cookieOptions);
      const url = new URL('https://discord.com/oauth2/authorize');
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirect.href,
        response_type: 'code',
        scope: 'identify',
        state,
      }).toString();
      reply.setCookie('os_oauth_state', state, { ...cookieOptions, maxAge: 600 });
      return reply.redirect(url.href);
    },
  );
  app.get(config.redirect.pathname, async (request, reply) => {
    const query = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(request.query);
    const cookieState = request.cookies.os_oauth_state;
    reply.clearCookie('os_oauth_state', cookieOptions);
    if (
      !query.state ||
      !cookieState ||
      !equal(query.state, cookieState) ||
      !store.consumeOAuthState(query.state)
    )
      throw new HttpError(400, 'Вход устарел. Вернитесь на главную страницу и повторите вход.');
    if (query.error || !query.code) return reply.redirect(config.appOrigin + '/?error=cancelled');
    const user = await oauth.exchange(query.code);
    const formReturn = request.cookies.ob_form_return;
    reply.clearCookie('ob_form_return', cookieOptions);
    if (!formReturn) {
      const access = await permissions(discord, store, config, user.id);
      if (!hasPanelAccess(access)) return reply.redirect(config.appOrigin + '/?error=forbidden');
    }
    if (request.cookies.os_session) store.deleteSession(request.cookies.os_session);
    const session = store.createSession(user);
    activity.record(
      { userId: user.id, name: user.name },
      { kind: 'auth.login', target: 'admin', summary: 'Вход в панель через Discord' },
    );
    reply.setCookie('os_session', session.token, { ...cookieOptions, maxAge: 8 * 60 * 60 });
    return reply.redirect(
      config.appOrigin +
        (formReturn && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(formReturn) ? '/forms/' + formReturn : '/'),
    );
  });
  app.get('/api/me', async (request) => {
    const session = request.adminSession!;
    return {
      user: { id: session.userId, name: session.name },
      csrf: session.csrf,
      permissions: request.adminAccess,
    };
  });
  app.post('/api/logout', async (request, reply) => {
    activity.record(actor(request), { kind: 'auth.logout', target: 'admin', summary: 'Выход из панели' });
    store.deleteSession(request.cookies.os_session || '');
    reply.clearCookie('os_session', cookieOptions);
    return { ok: true };
  });
  app.get('/api/workspace', async () => store.workspace());
  await composerRoutes(app, store, discord, activity);
  await moduleRoutes(app, config, store, discord, activity, options.errors);
  settingsRoutes(app, store, config, discord, activity);
  moderationRoutes(app, config, store, discord, activity);
  const moduleContext = {
    config,
    store,
    discord,
    activity,
    errors: options.errors || new ErrorReporter(config, 'web'),
  };
  communityRoutes(app, moduleContext);
  integrationRoutes(app, config, store, discord);
  const forms = new FormService(moduleContext);
  app.get('/api/applicant/me', async (request) => ({
    user: { id: request.adminSession!.userId, name: request.adminSession!.name },
    csrf: request.adminSession!.csrf,
  }));
  app.get('/api/applicant/forms/:id', async (request) => {
    const { id } = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/) }).parse(request.params);
    const { form } = forms.definition(id);
    await forms.available(form, request.adminSession!.userId);
    return {
      id: form.id,
      title: form.title,
      description: form.description,
      anonymous: form.anonymous,
      retentionDays: form.retentionDays,
      questions: form.questions,
    };
  });
  app.post('/api/applicant/forms/:id', async (request) => {
    const { id } = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/) }).parse(request.params),
      input = z
        .object({ answers: z.unknown(), caseId: z.number().int().positive().optional() })
        .parse(request.body);
    const draft = await forms.open(id, request.adminSession!.userId, input.caseId);
    return forms.submit(draft.id, request.adminSession!.userId, input.answers);
  });
  app.post(
    '/api/activity',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      const { events } = z.object({ events: z.array(uiEventSchema).min(1).max(20) }).parse(request.body);
      for (const event of events)
        activity.record(actor(request), {
          ...event,
          details: { context: event.context, occurredAt: event.occurredAt, source: 'browser' },
        });
      return { ok: true };
    },
  );
  app.get('/api/activity', async (request) => {
    const query = z
      .object({
        search: z.string().max(200).default(''),
        before: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    const page = activity.list(query.search, query.before);
    return { ...page, deliveryError: options.activityDeliveryError?.() || page.deliveryError };
  });
  app.get('/api/activity/export', async (request, reply) => {
    activity.record(actor(request), {
      kind: 'activity.export',
      target: 'activity',
      summary: 'Выгружен полный журнал JSONL',
    });
    return reply
      .type('application/x-ndjson')
      .header('Content-Disposition', 'attachment; filename="open-bot-activity.jsonl"')
      .send(Readable.from(activity.export()));
  });
  app.get('/api/guild', async () => discord.info());
  app.get('/api/runtime', async () => options.runtime?.() || { mode: 'standalone' });
  app.put('/api/draft', async (request) => {
    assertNotPublishing();
    const input = versionSchema.extend({ document: documentSchema }).parse(request.body);
    publisher.validate(input.document);
    const before = store.getDraft().document;
    const result = store.saveDraft(input.document, input.version, actor(request).userId);
    activity.record(actor(request), {
      kind: 'rules.save',
      target: 'rules',
      summary: 'Сохранён черновик правил и информации',
      before,
      after: input.document,
      details: { version: result.version },
    });
    return result;
  });
  app.put('/api/settings', async (request) => {
    assertNotPublishing();
    const input = settingsSchema.parse(request.body);
    const info = await discord.info();
    if (input.channelId && !info.channels.some((channel) => channel.id === input.channelId))
      throw new HttpError(400, 'Канал не найден на этом сервере');
    if (input.logChannelId && !info.channels.some((channel) => channel.id === input.logChannelId))
      throw new HttpError(400, 'Канал журнала не найден на этом сервере');
    if (input.adminRoleId && !info.roles.some((role) => role.id === input.adminRoleId))
      throw new HttpError(400, 'Роль не найдена на этом сервере');
    const actor = request.adminSession!.userId;
    if (!(await discord.authorize(actor, input.adminRoleId)))
      throw new HttpError(
        400,
        'Выберите роль, к которой у вас есть доступ, чтобы не потерять доступ к панели',
      );
    assertNotPublishing();
    const before = store.getSettings();
    store.saveSettings(input, actor);
    activity.record(request.adminSession!, {
      kind: 'settings.save',
      target: 'settings',
      summary: 'Изменены настройки',
      before,
      after: store.getSettings(),
    });
    return store.workspace();
  });
  app.post('/api/publish', async (request) => {
    const input = versionSchema.parse(request.body);
    await publisher.publish(request.adminSession!, input);
    return store.workspace();
  });
  app.post('/api/restore/:id', async (request) => {
    assertNotPublishing();
    const input = versionSchema.parse(request.body);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const before = store.getDraft().document;
    const document = store.revision(id).document;
    const result = store.saveDraft(document, input.version, actor(request).userId);
    activity.record(actor(request), {
      kind: 'rules.restore',
      target: `revision:${id}`,
      summary: 'Версия возвращена в черновик',
      before,
      after: document,
    });
    return result;
  });
  const webRoot = resolve('dist/web');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(serveStatic, { root: webRoot, prefix: '/' });
    app.get('/forms/:id', async (_request, reply) => reply.sendFile('index.html'));
  } else {
    app.get('/', async (_request, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Open Bot</title><p>Соберите интерфейс: npm run build. Для разработки откройте Vite на порту 5173.</p></html>',
        ),
    );
  }
  return app;
}
