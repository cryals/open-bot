import Fastify, { LogController, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { documentSchema, settingsSchema } from '../shared/rules.js';
import type { Config } from './config.js';
import type { DiscordPort } from './discord.js';
import type { OAuthPort } from './oauth.js';
import type { Store } from './store.js';
import { HttpError } from './errors.js';
import { validatePayloads } from './render.js';

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
}) {
  const { config, store, discord, oauth } = options;
  const app = Fastify({
    logger: options.logger ?? true,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.secureCookies ? [] : null,
      },
    },
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: config.secureCookies, path: '/' };
  let publishing = false;
  const assertNotPublishing = () => {
    if (publishing) throw new HttpError(409, 'Публикация уже выполняется. Дождитесь завершения.');
  };
  async function authenticate(request: FastifyRequest) {
    const session = store.session(request.cookies.os_session || '');
    if (!session) throw new HttpError(401, 'Войдите через Discord');
    if (!(await discord.authorize(session.userId, store.getSettings().adminRoleId))) {
      store.deleteSession(request.cookies.os_session || '');
      throw new HttpError(403, 'У вас нет роли администратора для этой панели');
    }
    return session;
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/auth/'))
      reply.header('Cache-Control', 'no-store');
    if (request.url.startsWith('/api/') && request.url.split('?')[0] !== '/api/health') {
      const session = await authenticate(request);
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
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply
        .code(400)
        .send({ error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n') });
    }
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    const known = error instanceof Error ? error : new Error('Unknown error');
    const code = 'code' in known ? String(known.code) : undefined;
    const statusCode = 'statusCode' in known ? Number(known.statusCode) : 500;
    const status = statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    // Deliberately omit request URLs, headers, bodies and OAuth query parameters.
    app.log.error({ name: known.name, code }, 'Request failed');
    return reply.code(status).send({
      error:
        status === 500
          ? 'Не удалось выполнить действие. Проверьте соединение бота и журнал сервера.'
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
    async (_request, reply) => {
      const state = store.createOAuthState();
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
    if (!(await discord.authorize(user.id, store.getSettings().adminRoleId)))
      return reply.redirect(config.appOrigin + '/?error=forbidden');
    if (request.cookies.os_session) store.deleteSession(request.cookies.os_session);
    const session = store.createSession(user);
    reply.setCookie('os_session', session.token, { ...cookieOptions, maxAge: 8 * 60 * 60 });
    return reply.redirect(config.appOrigin + '/');
  });
  app.get('/api/me', async (request) => {
    const session = store.session(request.cookies.os_session || '')!;
    return { user: { id: session.userId, name: session.name }, csrf: session.csrf };
  });
  app.post('/api/logout', async (request, reply) => {
    store.deleteSession(request.cookies.os_session || '');
    reply.clearCookie('os_session', cookieOptions);
    return { ok: true };
  });
  app.get('/api/workspace', async () => store.workspace());
  app.get('/api/guild', async () => discord.info());
  app.put('/api/draft', async (request) => {
    assertNotPublishing();
    const input = versionSchema.extend({ document: documentSchema }).parse(request.body);
    validatePayloads(input.document);
    return store.saveDraft(input.document, input.version, store.session(request.cookies.os_session!)!.userId);
  });
  app.put('/api/settings', async (request) => {
    assertNotPublishing();
    const input = settingsSchema.parse(request.body);
    const info = await discord.info();
    if (input.channelId && !info.channels.some((channel) => channel.id === input.channelId))
      throw new HttpError(400, 'Канал не найден на этом сервере');
    if (input.adminRoleId && !info.roles.some((role) => role.id === input.adminRoleId))
      throw new HttpError(400, 'Роль не найдена на этом сервере');
    const actor = store.session(request.cookies.os_session!)!.userId;
    if (!(await discord.authorize(actor, input.adminRoleId)))
      throw new HttpError(
        400,
        'Выберите роль, к которой у вас есть доступ, чтобы не потерять доступ к панели',
      );
    assertNotPublishing();
    store.saveSettings(input, actor);
    return store.workspace();
  });
  app.post('/api/publish', async (request) => {
    assertNotPublishing();
    const input = versionSchema.parse(request.body);
    const draft = store.getDraft();
    if (draft.version !== input.version)
      throw new HttpError(409, 'Черновик изменился. Обновите страницу перед публикацией.');
    const settings = store.getSettings();
    if (!settings.channelId) throw new HttpError(400, 'Сначала выберите канал в настройках');
    validatePayloads(draft.document);
    const actor = store.session(request.cookies.os_session!)!.userId;
    publishing = true;
    try {
      const messageId = await discord.upsert(draft.document, settings.channelId, settings);
      store.commitPublication(draft.document, actor, settings.channelId, messageId);
      if (
        settings.messageId &&
        settings.messageChannelId &&
        settings.messageChannelId !== settings.channelId
      ) {
        try {
          await discord.retire(settings.messageChannelId, settings.messageId);
        } catch {
          app.log.warn('New launcher published; old launcher could not be removed');
        }
      }
      return store.workspace();
    } finally {
      publishing = false;
    }
  });
  app.post('/api/restore/:id', async (request) => {
    assertNotPublishing();
    const input = versionSchema.parse(request.body);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    return store.saveDraft(
      store.revision(id).document,
      input.version,
      store.session(request.cookies.os_session!)!.userId,
    );
  });
  const webRoot = resolve('dist/web');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(serveStatic, { root: webRoot, prefix: '/' });
  } else {
    app.get('/', async (_request, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Open Space</title><p>Соберите интерфейс: npm run build. Для разработки откройте Vite на порту 5173.</p></html>',
        ),
    );
  }
  return app;
}
