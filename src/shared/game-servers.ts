import { z } from 'zod';

export const gameTypeSchema = z.enum(['ss14', 'ss13', 'minecraft', 'terraria', 'project-zomboid']);
export type GameType = z.infer<typeof gameTypeSchema>;
export const gameTitles: Record<GameType, string> = {
  ss14: 'Space Station 14',
  ss13: 'Space Station 13',
  minecraft: 'Minecraft',
  terraria: 'Terraria (TShock)',
  'project-zomboid': 'Project Zomboid',
};
export const gameAddresses: Record<GameType, string> = {
  ss14: 'ss14s://example.com',
  ss13: 'byond://example.com:1337',
  minecraft: 'minecraft://example.com:25565',
  terraria: 'https://example.com:7878',
  'project-zomboid': 'udp://example.com:16261',
};
export type GameServerStatus = {
  online: boolean;
  name: string;
  players: string;
  playerCount: number | null;
  maxPlayers: number | null;
  status: string;
  map: string;
  preset: string;
  roundId: string;
  roundMinutes: number | null;
  version: string;
  latencyMs: number;
  updatedAt: number;
  error?: string;
};
