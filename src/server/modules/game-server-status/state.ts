import { createHash } from 'node:crypto';
import type { GameServer } from '../../../shared/modules.js';
import { serverConfigSchema } from '../../../shared/modules.js';
import { gameTypeSchema, type GameServerStatus } from '../../../shared/game-servers.js';
import type { Store } from '../../store.js';
import { ModuleStore } from '../../module-store.js';

export const serverSignature = (server: GameServer) =>
  createHash('sha256').update(JSON.stringify(server)).digest('hex');
/** Metrics consume persisted projections only. No networking or user/server IDs in labels. */
export function monitorSummary(store: Store, now = Date.now()) {
  const servers = new ModuleStore(store).get('game-servers', serverConfigSchema, { servers: [] }).document
    .servers;
  const samples = store.sqlite.prepare('SELECT * FROM server_monitor_samples').all() as {
    server_id: string;
    signature: string;
    document: string;
    updated_at: number;
  }[];
  return gameTypeSchema.options.map((game) => {
    const result = {
      game,
      configured: 0,
      online: 0,
      offline: 0,
      unknown: 0,
      players: 0,
      capacity: 0,
      playerSamples: 0,
      oldestAge: 0,
      maxDuration: 0,
    };
    for (const server of servers.filter((server) => server.game === game)) {
      result.configured++;
      const sample = samples.find(
        (sample) => sample.server_id === server.id && sample.signature === serverSignature(server),
      );
      result.oldestAge = Math.max(
        result.oldestAge,
        sample ? Math.max(0, (now - sample.updated_at) / 1000) : 999,
      );
      if (!sample || sample.updated_at < now - 150000) {
        result.unknown++;
        continue;
      }
      const value = JSON.parse(sample.document) as GameServerStatus;
      result[value.online ? 'online' : 'offline']++;
      result.maxDuration = Math.max(result.maxDuration, value.latencyMs / 1000);
      if (value.online && value.playerCount !== null) {
        result.players += value.playerCount;
        result.playerSamples++;
      }
      if (value.online && value.maxPlayers !== null) result.capacity += value.maxPlayers;
    }
    return result;
  });
}
