import { randomUUID } from 'node:crypto';
import type { Store } from '../../store.js';
import type { DiscordPort } from '../../discord.js';
import type { Config } from '../../config.js';
import { ModuleStore } from '../../module-store.js';
import { serverConfigSchema, type GameServer } from '../../../shared/modules.js';
import type { BotMessage } from '../../../shared/blocks.js';
import { gameTitles, type GameServerStatus } from '../../../shared/game-servers.js';
import { HttpError } from '../../errors.js';
import { telemetry } from '../../telemetry.js';
import { ApplicationSettingsStore } from '../../application-settings.js';
import { gameEndpoint, queryGame } from './protocols.js';
import { serverSignature } from './state.js';
export { statusUrl } from './protocols.js';
export type ServerStatus = GameServerStatus;
const safe = (value: unknown) =>
  String(value ?? '?')
    .replace(/([\\`*_~|>])/g, '\\$1')
    .replace(/@/g, '@\u200b')
    .slice(0, 300);
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
    return this.store.sqlite
      .transaction(() => {
        const result = this.configStore.save('game-servers', serverConfigSchema, parsed, version);
        for (const server of before.servers)
          if (!parsed.servers.some((item) => item.id === server.id)) {
            this.store.sqlite
              .prepare('UPDATE server_watches SET enabled=0,next_at=0 WHERE server_id=?')
              .run(server.id);
            this.store.sqlite.prepare('DELETE FROM server_monitor_samples WHERE server_id=?').run(server.id);
          }
        return result;
      })
      .immediate();
  }
  validate(server: GameServer) {
    gameEndpoint(
      server,
      new ApplicationSettingsStore(this.store, this.config).get().document.gameServerHosts,
    );
  }
  async get(id: string): Promise<ServerStatus> {
    const server = this.settings().document.servers.find((server) => server.id === id);
    if (!server) throw new HttpError(404, 'Игровой сервер не найден');
    const { gameServerHosts: hosts, monitoring } = new ApplicationSettingsStore(this.store, this.config).get()
      .document;
    gameEndpoint(server, hosts);
    const key = serverSignature(server);
    const sample = this.store.sqlite
      .prepare(
        'SELECT document,updated_at,last_success_at FROM server_monitor_samples WHERE server_id=? AND signature=?',
      )
      .get(id, key) as { document: string; updated_at: number; last_success_at: number | null } | undefined;
    if (sample && sample.updated_at > Date.now() - monitoring.cacheSeconds * 1000)
      return JSON.parse(sample.document) as ServerStatus;
    const pending = this.requests.get(key);
    if (pending) return pending;
    const started = Date.now();
    const request = (async () => {
      let value: ServerStatus;
      try {
        value = await queryGame(server, hosts);
      } catch (error) {
        if (!sample || (JSON.parse(sample.document) as ServerStatus).online)
          this.onError(error, 'game-server-status.fetch');
        value = {
          online: false,
          name: server.name,
          players: '—',
          playerCount: null,
          maxPlayers: null,
          status: 'Недоступен',
          map: '—',
          preset: '—',
          roundId: '—',
          roundMinutes: null,
          version: '—',
          latencyMs: Date.now() - started,
          updatedAt: Date.now(),
          error:
            error instanceof HttpError
              ? error.message
              : 'Query не ответил корректно. Проверьте порт, протокол и доступ к status API; таймаут — 5 секунд.',
        };
      }
      const current = this.settings().document.servers.find((item) => item.id === id);
      if (current && serverSignature(current) === key) {
        this.store.sqlite
          .prepare(
            'INSERT INTO server_monitor_samples(server_id,game,signature,document,updated_at,last_success_at) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET game=excluded.game,signature=excluded.signature,document=excluded.document,updated_at=excluded.updated_at,last_success_at=excluded.last_success_at',
          )
          .run(
            id,
            server.game,
            key,
            JSON.stringify(value),
            value.updatedAt,
            value.online ? value.updatedAt : (sample?.last_success_at ?? null),
          );
      }
      telemetry.observe('game-server-status', 'fetch', value.online ? 'success' : 'error', started);
      telemetry.gameProbes.inc({ game: server.game, outcome: value.online ? 'success' : 'error' });
      telemetry.gameProbeDuration.observe({ game: server.game }, (Date.now() - started) / 1000);
      return value;
    })().finally(() => this.requests.delete(key));
    this.requests.set(key, request);
    return request;
  }
  message(server: GameServer, status: ServerStatus): BotMessage {
    const details = [
      `**Игра:** ${gameTitles[server.game]}`,
      `**Игроки:** ${safe(status.players)}`,
      `**Статус:** ${safe(status.status)}${status.roundMinutes !== null ? ' · ' + status.roundMinutes + ' мин' : ''}`,
    ];
    if (status.map !== '?') details.push(`**Карта / мир:** ${safe(status.map)}`);
    if (status.preset !== '?') details.push(`**Режим:** ${safe(status.preset)}`);
    if (['ss14', 'ss13'].includes(server.game) && status.roundId !== '?')
      details.push(`**Раунд:** ${safe(status.roundId)}`);
    if (status.version !== '?' && status.online) details.push(`**Версия:** ${safe(status.version)}`);
    if (status.online) details.push(`**Query:** ${Math.round(status.latencyMs)} мс`);
    if (status.error) details.push(safe(status.error));
    details.push(`-# ${safe(server.id)} · обновлено <t:${Math.floor(status.updatedAt / 1000)}:R>`);
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
            { id: 'details', type: 'text', content: details.join('\n') },
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
    if (this.busy) return;
    this.busy = true;
    try {
      const { gameServerHosts: hosts, monitoring } = new ApplicationSettingsStore(
        this.store,
        this.config,
      ).get().document;
      const refreshMs = monitoring.refreshSeconds * 1000;
      const queue = this.settings().document.servers.filter((server) => {
        try {
          gameEndpoint(server, hosts);
        } catch {
          return false;
        }
        const saved = this.store.sqlite
          .prepare('SELECT updated_at,signature FROM server_monitor_samples WHERE server_id=?')
          .get(server.id) as { updated_at: number; signature: string } | undefined;
        return (
          !saved || saved.signature !== serverSignature(server) || saved.updated_at < Date.now() - refreshMs
        );
      });
      // Bounded queries; all configured servers are monitored, even without a Discord watch.
      await Promise.all(
        Array.from({ length: Math.min(monitoring.concurrency, queue.length) }, async () => {
          for (;;) {
            const server = queue.shift();
            if (!server) return;
            await this.get(server.id).catch((error) => this.onError(error, 'game-server-status.poll'));
          }
        }),
      );
      if (!this.discord.isReady()) return;
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
            .run(messageId, Date.now() + refreshMs, watch.id);
        } catch (error) {
          if (!watch.error) this.onError(error, 'game-server-status.watch');
          this.store.sqlite
            .prepare('UPDATE server_watches SET error=?,next_at=? WHERE id=?')
            .run(
              'Не удалось обновить сообщение. Проверьте канал и права бота.',
              Date.now() + refreshMs,
              watch.id,
            );
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
