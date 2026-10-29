import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { snowflake } from '../shared/rules.js';

export type Config = {
  token: string;
  guildId: string;
  clientId: string;
  clientSecret: string;
  port: number;
  host: string;
  redirect: URL;
  origin: string;
  appOrigin: string;
  secureCookies: boolean;
  databasePath: string;
  adminRoleId: string | null;
  trustProxy: boolean;
  logChannelId?: string | null;
  logWebhook?: string | null;
};

export function loadConfig(): Config {
  dotenv.config({ path: [resolve('.env'), resolve('../.env')], quiet: true });
  const schema = z.object({
    BOT_TOKEN: z.string().min(20),
    GUILD_ID: snowflake,
    CLIENT_ID: snowflake,
    CLIENT_SECRET: z.string().min(10),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    REDIRECT: z.url(),
    HOST: z.string().default('127.0.0.1'),
    DATABASE_PATH: z.string().default('./data/open-bot.sqlite'),
    ADMIN_ROLE_ID: z.union([snowflake, z.literal('')]).optional(),
    TRUST_PROXY: z.enum(['true', 'false']).default('false'),
    APP_ORIGIN: z.url().optional(),
    LOG_ID: z.union([snowflake, z.literal('')]).optional(),
    LOG_WEBHOOK: z
      .union([
        z.url().refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === 'https:' &&
            ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(
              url.hostname,
            ) &&
            /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w.-]+$/.test(url.pathname) &&
            !url.username &&
            !url.password &&
            !url.hash &&
            !url.search
          );
        }, 'Use a Discord webhook URL'),
        z.literal(''),
      ])
      .optional(),
  });
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Report variable names only, never values (especially tokens).
    throw new Error('Проверьте .env: ' + parsed.error.issues.map((issue) => issue.path.join('.')).join(', '));
  }
  const env = parsed.data;
  const redirect = new URL(env.REDIRECT);
  if (
    !['http:', 'https:'].includes(redirect.protocol) ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password ||
    redirect.pathname === '/'
  ) {
    throw new Error(
      'REDIRECT должен быть полным HTTP(S) URL callback, без query/fragment, например http://localhost:3000/auth/discord/callback',
    );
  }
  const appOrigin = new URL(env.APP_ORIGIN || redirect.origin);
  if (
    appOrigin.hostname !== redirect.hostname ||
    appOrigin.protocol !== redirect.protocol ||
    appOrigin.origin !== appOrigin.href.replace(/\/$/, '')
  ) {
    throw new Error('APP_ORIGIN должен быть origin на том же hostname и протоколе, что REDIRECT');
  }
  return {
    token: env.BOT_TOKEN,
    guildId: env.GUILD_ID,
    clientId: env.CLIENT_ID,
    clientSecret: env.CLIENT_SECRET,
    port: env.PORT,
    host: env.HOST,
    redirect,
    origin: redirect.origin,
    appOrigin: appOrigin.origin,
    secureCookies: redirect.protocol === 'https:',
    databasePath: resolve(env.DATABASE_PATH),
    adminRoleId: env.ADMIN_ROLE_ID || null,
    trustProxy: env.TRUST_PROXY === 'true',
    logChannelId: env.LOG_ID || null,
    logWebhook: env.LOG_WEBHOOK || null,
  };
}
