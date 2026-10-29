import { z } from 'zod';
import type { Config } from './config.js';
import type { SessionUser } from '../shared/rules.js';
import { HttpError } from './errors.js';

export interface OAuthPort {
  exchange(code: string): Promise<SessionUser>;
}

export class DiscordOAuth implements OAuthPort {
  constructor(private config: Config) {}
  async exchange(code: string): Promise<SessionUser> {
    const token = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirect.href,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!token.ok) throw new HttpError(400, 'Авторизация Discord не завершена. Повторите вход.');
    const data = z.object({ access_token: z.string() }).parse(await token.json());
    const user = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { authorization: 'Bearer ' + data.access_token },
      signal: AbortSignal.timeout(15000),
    });
    if (!user.ok) throw new HttpError(502, 'Discord не вернул профиль. Повторите вход.');
    const profile = z
      .object({ id: z.string(), username: z.string(), global_name: z.string().nullable().optional() })
      .parse(await user.json());
    // OAuth tokens are discarded. Subsequent authorization checks use the bot's member REST API.
    return { id: profile.id, name: profile.global_name || profile.username };
  }
}
