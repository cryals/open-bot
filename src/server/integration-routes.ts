import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import { requireCapability } from './access.js';
import { IntegrationVault } from './integration-vault.js';
import { CommunityStore } from './community-store.js';
import { limitedResponse } from './module-http.js';
import { HttpError } from './errors.js';
const providers = z.enum(['twitch', 'kick', 'tiktok', 'reddit', 'vk']);
const oauthProviders = {
  twitch: {
    authorize: 'https://id.twitch.tv/oauth2/authorize',
    token: 'https://id.twitch.tv/oauth2/token',
    scope: '',
  },
  kick: {
    authorize: 'https://id.kick.com/oauth/authorize',
    token: 'https://id.kick.com/oauth/token',
    scope: 'channel:read livestreams:read',
  },
  tiktok: {
    authorize: 'https://www.tiktok.com/v2/auth/authorize/',
    token: 'https://open.tiktokapis.com/v2/oauth/token/',
    scope: 'user.info.basic,video.list',
  },
  reddit: {
    authorize: 'https://www.reddit.com/api/v1/authorize',
    token: 'https://www.reddit.com/api/v1/access_token',
    scope: 'read',
  },
  vk: {
    authorize: 'https://id.vk.com/authorize',
    token: 'https://id.vk.com/oauth2/auth',
    scope: 'wall groups offline',
  },
};
export function integrationRoutes(app: FastifyInstance, config: Config, store: Store, discord: DiscordPort) {
  const vault = new IntegrationVault(store),
    stateStore = new CommunityStore(store);
  app.get('/api/community/integrations', async (request) => {
    await requireCapability(discord, store, config, request.adminSession!.userId, 'feedsManage');
    return {
      accounts: vault.list(),
      oauthProviders: Object.keys(oauthProviders),
      ready: !!process.env.INTEGRATION_KEY,
    };
  });
  app.put('/api/community/integrations/:provider', async (request) => {
    await requireCapability(discord, store, config, request.adminSession!.userId, 'feedsManage');
    const { provider } = z.object({ provider: providers }).parse(request.params),
      input = z
        .object({
          account: z.string().regex(/^[a-zA-Z0-9_.@-]{1,150}$/),
          accessToken: z.string().min(1).max(10000),
          refreshToken: z.string().max(10000).optional(),
          expiresAt: z.number().int().optional(),
        })
        .parse(request.body);
    vault.save(provider, input.account, { ...input, refreshToken: input.refreshToken || undefined });
    return { ok: true };
  });
  app.delete('/api/community/integrations/:provider/:account', async (request) => {
    await requireCapability(discord, store, config, request.adminSession!.userId, 'feedsManage');
    const { provider, account } = z
      .object({ provider: providers, account: z.string().max(150) })
      .parse(request.params);
    vault.remove(provider, account);
    return { ok: true };
  });
  app.get('/auth/integrations/:provider', async (request, reply) => {
    const session = store.session(request.cookies.os_session || '');
    if (!session) throw new HttpError(401, 'Войдите в панель');
    await requireCapability(discord, store, config, session.userId, 'feedsManage');
    const { provider } = z.object({ provider: providers }).parse(request.params),
      settings = oauthProviders[provider],
      client = process.env[provider.toUpperCase() + '_CLIENT_ID'];
    if (!client || !process.env.INTEGRATION_KEY)
      throw new HttpError(503, 'OAuth приложения не настроен в техническом ENV');
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(32).toString('base64url'),
      redirect = config.origin + '/auth/integrations/' + provider + '/callback';
    stateStore.set('integrations', 'oauth:' + state, {
      provider,
      user: session.userId,
      verifier,
      redirect,
      expires: Date.now() + 600000,
    });
    reply.setCookie('ob_integration_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      path: '/auth/integrations',
      maxAge: 600,
    });
    const url = new URL(settings.authorize);
    url.search = new URLSearchParams({
      [provider === 'tiktok' ? 'client_key' : 'client_id']: client,
      response_type: 'code',
      redirect_uri: redirect,
      scope: settings.scope,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...(provider === 'reddit' ? { duration: 'permanent' } : {}),
    }).toString();
    return reply.redirect(url.href);
  });
  app.get('/auth/integrations/:provider/callback', async (request, reply) => {
    const { provider } = z.object({ provider: providers }).parse(request.params),
      query = z
        .object({
          state: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
          code: z.string().max(2000).optional(),
          error: z.string().max(100).optional(),
          device_id: z.string().max(300).optional(),
        })
        .parse(request.query);
    const saved = stateStore.state<{
        provider: string;
        user: string;
        verifier: string;
        redirect: string;
        expires: number;
      }>('integrations', 'oauth:' + query.state),
      session = store.session(request.cookies.os_session || '');
    store.sqlite
      .prepare("DELETE FROM module_state WHERE module='integrations' AND key=?")
      .run('oauth:' + query.state);
    reply.clearCookie('ob_integration_state', { path: '/auth/integrations' });
    if (
      !saved ||
      saved.provider !== provider ||
      saved.expires < Date.now() ||
      saved.user !== session?.userId ||
      query.state !== request.cookies.ob_integration_state
    )
      throw new HttpError(400, 'OAuth подтверждение устарело');
    await requireCapability(discord, store, config, session.userId, 'feedsManage');
    if (query.error || !query.code) return reply.redirect(config.appOrigin + '/?integration=cancelled');
    const prefix = provider.toUpperCase(),
      client = process.env[prefix + '_CLIENT_ID'] || '',
      secret = process.env[prefix + '_CLIENT_SECRET'] || '',
      headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (provider === 'reddit') {
      headers.authorization = 'Basic ' + Buffer.from(client + ':' + secret).toString('base64');
      headers['User-Agent'] = 'OpenBot/1.0';
    }
    const response = await fetch(oauthProviders[provider].token, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: saved.redirect,
        code_verifier: saved.verifier,
        [provider === 'tiktok' ? 'client_key' : 'client_id']: client,
        client_secret: secret,
        ...(query.device_id ? { device_id: query.device_id, state: query.state } : {}),
      }),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new HttpError(400, 'Провайдер отклонил OAuth; проверьте redirect и права приложения');
    const data = z
      .object({
        access_token: z.string(),
        refresh_token: z.string().optional(),
        expires_in: z.number().optional(),
        open_id: z.string().optional(),
        scope: z.string().optional(),
      })
      .parse(JSON.parse(await limitedResponse(response)));
    vault.save(provider, provider === 'tiktok' ? data.open_id || 'default' : 'default', {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scopes: data.scope?.split(/[ ,]/),
    });
    return reply.redirect(config.appOrigin + '/?integration=connected');
  });
}
