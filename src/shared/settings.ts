import { z } from 'zod';
import { snowflakeId } from './modules.js';

export const capabilityNames = [
  'moderationView',
  'moderationManage',
  'rolesManage',
  'formsView',
  'formsManage',
  'giveawaysManage',
  'feedsManage',
  'backupManage',
] as const;
export type Capability = (typeof capabilityNames)[number];
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .refine(
    (value) => !/[\s/@?#:*]/.test(value) && /^[a-z0-9.-]+$/.test(value),
    'Укажите имя хоста без протокола, порта и пути',
  );
export const applicationSettingsSchema = z.object({
  errorChannelId: snowflakeId.nullable(),
  gateway: z
    .object({
      messages: z.boolean(),
      messageContent: z.boolean(),
      members: z.boolean(),
      moderation: z.boolean(),
      reactions: z.boolean(),
      autoModeration: z.boolean().default(false),
    })
    .refine((value) => !value.messageContent || value.messages, 'Message Content требует Guild Messages'),
  metricsEnabled: z.boolean(),
  gameServerHosts: z.array(hostname).max(100),
  watchdogHosts: z.array(hostname).max(100),
  monitoring: z
    .object({
      refreshSeconds: z.number().int().min(30).max(3600).default(60),
      cacheSeconds: z.number().int().min(1).max(30).default(15),
      concurrency: z.number().int().min(1).max(8).default(4),
    })
    .default({ refreshSeconds: 60, cacheSeconds: 15, concurrency: 4 }),
  grants: z.object(
    Object.fromEntries(capabilityNames.map((key) => [key, z.array(snowflakeId).max(20)])) as Record<
      Capability,
      z.ZodArray<typeof snowflakeId>
    >,
  ),
});
export type ApplicationSettings = z.infer<typeof applicationSettingsSchema>;
export const defaultApplicationSettings: ApplicationSettings = {
  errorChannelId: null,
  gateway: {
    messages: false,
    messageContent: false,
    members: false,
    moderation: false,
    reactions: false,
    autoModeration: false,
  },
  metricsEnabled: false,
  gameServerHosts: [],
  watchdogHosts: [],
  monitoring: { refreshSeconds: 60, cacheSeconds: 15, concurrency: 4 },
  grants: Object.fromEntries(capabilityNames.map((key) => [key, [] as string[]])) as Record<
    Capability,
    string[]
  >,
};
export const capabilityTitles: Record<Capability, string> = {
  moderationView: 'Чтение дел модерации',
  moderationManage: 'Модерация и наказания',
  rolesManage: 'Панели ролей',
  formsView: 'Чтение заявок',
  formsManage: 'Управление формами',
  giveawaysManage: 'Розыгрыши',
  feedsManage: 'Подписки',
  backupManage: 'Резервные копии сервера',
};
export type ApplicationSettingsSnapshot = {
  document: ApplicationSettings;
  version: number;
  appliedGateway: ApplicationSettings['gateway'] | null;
  restartRequired: boolean;
  restartAvailable: boolean;
  metricsReady: boolean;
  metricsPort: number;
};
