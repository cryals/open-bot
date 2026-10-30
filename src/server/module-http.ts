import type { REST } from 'discord.js';
import type { DiscordPort } from './discord.js';
import type { Config } from './config.js';
import { HttpError } from './errors.js';

export type RestPort = Pick<REST, 'get' | 'post' | 'put' | 'patch' | 'delete'>;
export function restPort(discord: DiscordPort): RestPort {
  if (!discord.rest) throw new HttpError(503, 'Discord REST недоступен');
  return discord.rest;
}
export function allowedEndpoint(address: string, hosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new HttpError(400, 'Некорректный адрес сервера');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw new HttpError(400, 'Адрес должен быть HTTP(S), без пароля, query и fragment');
  if (!hosts.includes(url.hostname.toLowerCase()))
    throw new HttpError(400, 'Хост не разрешён в ENV allowlist');
  return url;
}
export async function limitedResponse(response: Response, limit = 256 * 1024): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new HttpError(502, 'Ответ сервера слишком большой');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function secretValues(config: Config) {
  return [
    config.token,
    config.clientSecret,
    config.logWebhook || '',
    config.redisUrl || '',
    config.metricsToken || '',
    ...Object.entries(process.env)
      .filter(([name]) => /^WATCHDOG_TOKEN_[A-Z0-9_]+$/.test(name))
      .map(([, value]) => value || ''),
  ];
}
