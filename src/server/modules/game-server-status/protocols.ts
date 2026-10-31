import { createConnection } from 'node:net';
import { GameDig } from 'gamedig';
import { z } from 'zod';
import type { GameServer } from '../../../shared/modules.js';
import type { GameServerStatus } from '../../../shared/game-servers.js';
import { limitedResponse } from '../../module-http.js';
import { HttpError } from '../../errors.js';

const scalar = z.union([z.string().max(300), z.number().finite()]);
const count = (value: unknown): number | null => {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 1000000 ? number : null;
};
const text = (value: unknown, fallback = '?') =>
  typeof value === 'string'
    ? value.slice(0, 300)
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : fallback;
export function statusUrl(address: string) {
  const url = new URL(address.includes('://') ? address : 'ss14://' + address);
  if (url.username || url.password || url.search || url.hash)
    throw new HttpError(400, 'Адрес не должен содержать пароль, query или fragment');
  if (!['ss14:', 'ss14s:', 'http:', 'https:'].includes(url.protocol))
    throw new HttpError(400, 'Используйте ss14:// или ss14s://');
  const secure = ['ss14s:', 'https:'].includes(url.protocol);
  return new URL(
    `${secure ? 'https' : 'http'}://${url.hostname}:${url.port || (secure ? '443' : '1212')}${url.pathname.replace(/\/$/, '')}/status`,
  );
}
export function gameEndpoint(server: GameServer, hosts: string[]) {
  let url: URL;
  try {
    if (server.game === 'ss14') url = statusUrl(server.address);
    else {
      const scheme = (
        { ss13: 'byond', minecraft: 'minecraft', terraria: 'http', 'project-zomboid': 'udp' } as const
      )[server.game];
      url = new URL(server.address.includes('://') ? server.address : scheme + '://' + server.address);
      const protocols =
        server.game === 'terraria'
          ? ['http:', 'https:']
          : server.game === 'minecraft'
            ? ['minecraft:', 'bedrock:']
            : server.game === 'ss13'
              ? ['byond:']
              : ['udp:', 'pz:'];
      if (!protocols.includes(url.protocol))
        throw new HttpError(400, 'Протокол адреса не соответствует выбранной игре');
      if (server.game !== 'terraria' && url.pathname && url.pathname !== '/')
        throw new HttpError(400, 'Для игрового query укажите только хост и порт');
      if (!url.port && server.game !== 'terraria')
        url.port = String(
          server.game === 'minecraft'
            ? url.protocol === 'bedrock:'
              ? 19132
              : 25565
            : server.game === 'project-zomboid'
              ? 16261
              : 0,
        );
      if (url.port === '0') throw new HttpError(400, 'Укажите порт BYOND');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Некорректный адрес игрового сервера');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new HttpError(400, 'Не помещайте токен или пароль в адрес');
  if (!hosts.includes(url.hostname.toLowerCase()))
    throw new HttpError(400, 'Хост не разрешён в настройках приложения');
  if (server.tokenEnv && server.game !== 'terraria')
    throw new HttpError(400, 'REST-токен поддерживается только для Terraria TShock');
  return url;
}
async function jsonStatus(url: URL) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'Open-Bot/1.3.0 (game status)' },
  });
  if (!response.ok) throw new Error('Game status HTTP ' + response.status);
  return JSON.parse(await limitedResponse(response, 256 * 1024)) as unknown;
}

/** BYOND topic framing: 0x0083, big-endian size, five zero bytes, ?status, NUL. */
async function byondStatus(url: URL): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
    let data = Buffer.alloc(0),
      done = false;
    const finish = (error?: Error, value?: Record<string, string>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('BYOND status timeout')), 5000);
    socket.on('error', (error) => finish(error));
    socket.on('end', () => finish(new Error('BYOND status response truncated')));
    socket.on('connect', () => {
      const payload = Buffer.from('\0\0\0\0\0?status\0', 'binary'),
        header = Buffer.from([0, 131, 0, 0]);
      header.writeUInt16BE(payload.length, 2);
      socket.write(Buffer.concat([header, payload]));
    });
    socket.on('data', (chunk) => {
      if (data.length + chunk.length > 65539) {
        finish(new Error('BYOND response too large'));
        return;
      }
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      if (data.readUInt16BE(0) !== 131) {
        finish(new Error('Invalid BYOND response header'));
        return;
      }
      const size = data.readUInt16BE(2);
      if (size < 2) {
        finish(new Error('Empty BYOND status'));
        return;
      }
      if (data.length < size + 4) return;
      if (data[4] !== 6) {
        finish(new Error('BYOND status is not a string'));
        return;
      }
      const values = Object.fromEntries(
        new URLSearchParams(
          data
            .subarray(5, size + 4)
            .toString('utf8')
            .replace(/\0+$/, ''),
        ),
      );
      if (!['players', 'name', 'server_name', 'mode', 'version', 'round_id'].some((key) => key in values)) {
        finish(new Error('Unrecognized BYOND status'));
        return;
      }
      finish(undefined, values);
    });
  });
}

export async function queryGame(server: GameServer, hosts: string[]): Promise<GameServerStatus> {
  const url = gameEndpoint(server, hosts),
    started = performance.now();
  const result: GameServerStatus = {
    online: true,
    name: server.name,
    players: '?',
    playerCount: null,
    maxPlayers: null,
    status: 'В сети',
    map: '?',
    preset: '?',
    roundId: '?',
    roundMinutes: null,
    version: '?',
    latencyMs: 0,
    updatedAt: Date.now(),
  };
  if (server.game === 'ss14') {
    const data = z
      .object({
        name: z.string().max(300).optional(),
        players: scalar.optional(),
        soft_max_players: scalar.optional(),
        round_id: scalar.optional(),
        map: z.string().max(200).optional(),
        preset: z.string().max(200).optional(),
        run_level: z.number().int().optional(),
        round_start_time: z.string().max(100).nullable().optional(),
      })
      .parse(await jsonStatus(url));
    result.name = data.name || server.name;
    result.playerCount = count(data.players);
    result.maxPlayers = count(data.soft_max_players);
    result.status =
      ({ 0: 'Лобби', 1: 'В игре', 2: 'Завершение' } as Record<number, string>)[data.run_level ?? -1] ||
      'Неизвестно';
    result.map = data.map || '?';
    result.preset = data.preset || '?';
    result.roundId = text(data.round_id);
    const start = Date.parse(data.round_start_time || '');
    if (data.run_level === 1 && Number.isFinite(start))
      result.roundMinutes = Math.max(0, Math.floor((Date.now() - start) / 60000));
  } else if (server.game === 'ss13') {
    const data = await byondStatus(url);
    result.name = data.name || data.server_name || server.name;
    result.playerCount = count(data.players);
    result.maxPlayers = count(data.playerlimit ?? data.popcap ?? data.max_players);
    result.map = text(data.map_name ?? data.map);
    result.preset = text(data.mode);
    result.roundId = text(data.round_id);
    result.version = text(data.version);
    result.status = text(data.game_state ?? data.round_status, 'В сети');
    const duration = count(data.round_duration);
    if (duration !== null) result.roundMinutes = Math.floor(duration / 60);
  } else if (server.game === 'terraria') {
    url.pathname = url.pathname.replace(/\/$/, '') + '/v2/server/status';
    if (server.tokenEnv) {
      const token = process.env[server.tokenEnv];
      if (!token) throw new HttpError(503, 'Не задан ENV-токен TShock');
      url.searchParams.set('token', token);
    }
    const data = z
      .object({
        status: z.union([z.string(), z.number()]),
        name: z.string().max(300).optional(),
        world: z.string().max(300).optional(),
        playercount: scalar.optional(),
        maxplayers: scalar.optional(),
        serverversion: scalar.optional(),
        tshockversion: scalar.optional(),
      })
      .parse(await jsonStatus(url));
    if (String(data.status) !== '200')
      throw new HttpError(403, 'TShock отклонил status-запрос. Проверьте токен и REST-права.');
    result.name = data.name || server.name;
    result.playerCount = count(data.playercount);
    result.maxPlayers = count(data.maxplayers);
    result.map = text(data.world);
    result.version = text(data.serverversion ?? data.tshockversion);
    result.preset = 'TShock';
  } else {
    const type =
      server.game === 'project-zomboid'
        ? 'projectzomboid'
        : url.protocol === 'bedrock:'
          ? 'protocol-minecraftbedrock'
          : 'protocol-minecraftvanilla';
    const options = {
      type,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port),
      givenPortOnly: true,
      maxRetries: 0,
      socketTimeout: 2000,
      attemptTimeout: 5000,
      requestPlayers: false,
      requestRules: false,
      portCache: false,
    };
    const data = await GameDig.query(options);
    const raw = data.raw as { version?: { name?: unknown } };
    result.name = text(data.name, server.name) || server.name;
    result.playerCount = count(data.numplayers);
    result.maxPlayers = count(data.maxplayers);
    result.map = text(data.map) || '?';
    result.version = text(data.version || raw.version?.name);
    result.preset = server.game === 'minecraft' ? (url.protocol === 'bedrock:' ? 'Bedrock' : 'Java') : '?';
  }
  result.players = `${result.playerCount ?? '?'}/${result.maxPlayers ?? '?'}`;
  result.latencyMs = Math.max(0, performance.now() - started);
  result.updatedAt = Date.now();
  return result;
}
