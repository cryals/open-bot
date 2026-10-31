import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../store.js';
import type { DiscordPort } from '../../discord.js';
import type { Config } from '../../config.js';
import { ModuleStore } from '../../module-store.js';
import { allowedEndpoint, limitedResponse } from '../../module-http.js';
import { serverConfigSchema, type GameServer } from '../../../shared/modules.js';
import type { BotMessage } from '../../../shared/blocks.js';
import { HttpError } from '../../errors.js';
import { telemetry } from '../../telemetry.js';
import { ApplicationSettingsStore } from '../../application-settings.js';

export function statusUrl(address: string) {
  const source = address.includes('://') ? address : 'ss14://' + address;
  const url = new URL(source);
  if (url.username || url.password || url.search || url.hash)
    throw new HttpError(400, 'Адрес статуса не должен содержать credentials, query или fragment');
  if (!['ss14:', 'ss14s:', 'http:', 'https:'].includes(url.protocol))
    throw new HttpError(400, 'Используйте ss14:// или ss14s://');
  const secure = ['ss14s:', 'https:'].includes(url.protocol);
  const port = url.port || (secure ? '443' : '1212');
  // URL.protocol cannot replace a non-special protocol with HTTP directly.
  return new URL(
    `${secure ? 'https' : 'http'}://${url.hostname}:${port}${url.pathname.replace(/\/$/, '')}/status`,
  );
}
const scalar = z.union([z.string().max(200), z.number()]);
const responseSchema = z.object({
  name: z.string().max(300).optional(),
  players: scalar.optional(),
  soft_max_players: scalar.optional(),
  round_id: scalar.optional(),
  map: z.string().max(200).optional(),
  preset: z.string().max(200).optional(),
  run_level: z.number().int().optional(),
  round_start_time: z.string().max(100).nullable().optional(),
});
const safe = (value: unknown) =>
  String(value ?? '?')
    .replace(/([\\`*_~|>])/g, '\\$1')
    .replace(/@/g, '@\u200b')
    .slice(0, 300);
export type ServerStatus = {
  online: boolean;
  name: string;
  players: string;
  status: string;
  map: string;
  preset: string;
  roundId: string;
  roundMinutes: number | null;
  updatedAt: number;
  error?: string;
};
type Watch = {
  id: number;
  server_id: string;
  channel_id: string;
  message_id: string | null;
  nonce: string;
  enabled: number;
  next_at: number;
  error: string | null;
};
export class ServerStatusService {
  readonly configStore: ModuleStore;
  private cache = new Map<string, { expires: number; value: ServerStatus }>();
  private requests = new Map<string, Promise<ServerStatus>>();
  private busy = false;
  constructor(
    private config: Config,
    private store: Store,
    private discord: DiscordPort,
    private onError: (error: unknown, scope: string) => void = () => {},
  ) {
    this.configStore = new ModuleStore(store);
  }
  settings() {
    return this.configStore.get('game-servers', serverConfigSchema, { servers: [] });
  }
  save(document: unknown, version: number) {
    const parsed = serverConfigSchema.parse(document);
    for (const server of parsed.servers) this.validate(server);
    const before = this.settings().document;
    const result = this.store.sqlite
      .transaction(() => {
        const saved = this.configStore.save('game-servers', serverConfigSchema, parsed, version);
        for (const server of before.servers)
          if (!parsed.servers.some((item) => item.id === server.id))
            this.store.sqlite
              .prepare('UPDATE server_watches SET enabled=0,next_at=0 WHERE server_id=?')
              .run(server.id);
        return saved;
      })
      .immediate();
    this.cache.clear();
    return result;
  }
  validate(server: GameServer) {
    allowedEndpoint(
      statusUrl(server.address).href,
      new ApplicationSettingsStore(this.store, this.config).get().document.gameServerHosts,
    );
  }
  async get(id: string): Promise<ServerStatus> {
    const server = this.settings().document.servers.find((server) => server.id === id);
    if (!server) throw new HttpError(404, 'Игровой сервер не найден');
    const key = server.id + ':' + server.address;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const pending = this.requests.get(key);
    if (pending) return pending;
    const started = Date.now();
    const request = (async () => {
      let value: ServerStatus;
      try {
        const url = allowedEndpoint(
          statusUrl(server.address).href,
          new ApplicationSettingsStore(this.store, this.config).get().document.gameServerHosts,
        );
        const response = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'Open-Bot/1.0 (SS14 status)' },
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = responseSchema.parse(JSON.parse(await limitedResponse(response)));
        const start = data.round_start_time ? Date.parse(data.round_start_time) : NaN;
        value = {
          online: true,
          name: data.name || server.name,
          players: `${data.players ?? '?'}/${data.soft_max_players ?? '?'}`,
          status:
            ({ 0: 'Лобби', 1: 'В игре', 2: 'Завершение' } as Record<number, string>)[data.run_level ?? -1] ||
            'Неизвестно',
          map: data.map || '?',
          preset: data.preset || '?',
          roundId: String(data.round_id ?? '?'),
          roundMinutes:
            data.run_level === 1 && Number.isFinite(start)
              ? Math.max(0, Math.floor((Date.now() - start) / 60000))
              : null,
          updatedAt: Date.now(),
        };
      } catch (error) {
        if (!cached || cached.value.online) this.onError(error, 'game-server-status.fetch');
        value = {
          online: false,
          name: server.name,
          players: '—',
          status: 'Недоступен',
          map: '—',
          preset: '—',
          roundId: '—',
          roundMinutes: null,
          updatedAt: Date.now(),
          error: 'Сервер не ответил корректно за 5 секунд',
        };
      }
      telemetry.observe('game-server-status', 'fetch', value.online ? 'success' : 'error', started);
      if (this.cache.size >= 60) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: Date.now() + 15000, value });
      return value;
    })().finally(() => this.requests.delete(key));
    this.requests.set(key, request);
    return request;
  }
  message(server: GameServer, status: ServerStatus): BotMessage {
    return {
      id: server.id,
      silent: true,
      mentions: { users: false, roles: false, everyone: false },
      blocks: [
        {
          id: 'status',
          type: 'container',
          color: status.online ? '#deded9' : '#7f302e',
          spoiler: false,
          children: [
            { id: 'title', type: 'text', content: `## ${safe(status.name)}` },
            { id: 'separator', type: 'separator', divider: true, spacing: 'small' },
            {
              id: 'details',
              type: 'text',
              content: `**Игроки:** ${safe(status.players)}\n**Статус:** ${safe(status.status)}${status.roundMinutes !== null ? ' · ' + status.roundMinutes + ' мин' : ''}\n**Карта:** ${safe(status.map)}\n**Режим:** ${safe(status.preset)}\n**Раунд:** ${safe(status.roundId)}\n\n${status.error ? safe(status.error) + '\n' : ''}-# ${safe(server.id)} · обновлено <t:${Math.floor(status.updatedAt / 1000)}:R>`,
            },
          ],
        },
      ],
    };
  }
  watches() {
    return this.store.sqlite.prepare('SELECT * FROM server_watches ORDER BY id').all() as Watch[];
  }
  async addWatch(serverId: string, channelId: string) {
    if (!this.settings().document.servers.some((server) => server.id === serverId))
      throw new HttpError(404, 'Сервер не найден');
    if (!(await this.discord.info()).channels.some((channel) => channel.id === channelId))
      throw new HttpError(400, 'Канал не найден');
    this.store.sqlite
      .prepare(
        'INSERT INTO server_watches(server_id,channel_id,nonce) VALUES(?,?,?) ON CONFLICT(server_id,channel_id) DO UPDATE SET enabled=1,next_at=0',
      )
      .run(serverId, channelId, randomUUID());
    return this.watches();
  }
  removeWatch(id: number) {
    this.store.sqlite.prepare('UPDATE server_watches SET enabled=0,next_at=0 WHERE id=?').run(id);
  }
  async tick() {
    if (this.busy || !this.discord.isReady()) return;
    this.busy = true;
    try {
      for (const watch of this.watches()
        .filter((watch) => watch.next_at <= Date.now())
        .slice(0, 10)) {
        try {
          if (!watch.enabled) {
            if (watch.message_id) await this.discord.retire(watch.channel_id, watch.message_id);
            this.store.sqlite.prepare('DELETE FROM server_watches WHERE id=?').run(watch.id);
            continue;
          }
          const server = this.settings().document.servers.find((server) => server.id === watch.server_id);
          if (!server) throw new Error('Сервер удалён');
          const message = this.message(server, await this.get(server.id));
          let messageId = watch.message_id;
          if (messageId) {
            try {
              await this.discord.editMessage(message, watch.channel_id, messageId);
            } catch (error) {
              if ((error as { code?: number }).code !== 10008) throw error;
              messageId = null;
            }
          }
          if (!messageId) messageId = await this.discord.sendMessage(message, watch.channel_id, watch.nonce);
          this.store.sqlite
            .prepare('UPDATE server_watches SET message_id=?,next_at=?,error=NULL WHERE id=?')
            .run(messageId, Date.now() + 60000, watch.id);
        } catch (error) {
          if (!watch.error) this.onError(error, 'game-server-status.watch');
          this.store.sqlite
            .prepare('UPDATE server_watches SET error=?,next_at=? WHERE id=?')
            .run(
              'Не удалось обновить сообщение. Проверьте канал и права бота.',
              Date.now() + 60000,
              watch.id,
            );
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
