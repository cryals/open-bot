import { z } from 'zod';
import { snowflakeId, blocksSchema } from './modules.js';
export const moderationActionSchema = z.enum([
  'warn',
  'note',
  'kick',
  'ban',
  'tempban',
  'softban',
  'unban',
  'timeout',
  'untimeout',
  'role-mute',
  'unmute',
  'purge',
  'lock',
  'unlock',
]);
export type ModerationAction = z.infer<typeof moderationActionSchema>;
export const moderationRequestSchema = z.object({
  action: moderationActionSchema,
  target: snowflakeId,
  reason: z.string().trim().min(1).max(1000),
  duration: z.number().int().min(1).max(315360000).nullable().default(null),
  deleteSeconds: z.number().int().min(0).max(604800).default(0),
  purge: z
    .object({
      count: z.number().int().min(1).max(1000),
      author: snowflakeId.optional(),
      contains: z.string().max(200).optional(),
      type: z.enum(['all', 'bots', 'attachments']).default('all'),
      includePinned: z.boolean().default(false),
    })
    .optional(),
  operationId: z.string().uuid(),
});
export type ModerationRequest = z.infer<typeof moderationRequestSchema>;
export const moderationConfigSchema = z.object({
  enabled: z.boolean(),
  protectedRoles: z.array(snowflakeId).max(100),
  notifyDm: z.boolean(),
  appealUrl: z.union([z.url().refine((value) => new URL(value).protocol === 'https:'), z.literal('')]),
  muteRole: snowflakeId.nullable(),
  removeOnMute: z.array(snowflakeId).max(100),
  escalation: z
    .array(
      z.object({
        warnings: z.number().int().min(1).max(1000),
        action: z.enum(['timeout', 'kick', 'ban']),
        duration: z.number().int().min(1).max(2419200).nullable(),
      }),
    )
    .max(20),
});
export const initialModerationConfig: z.infer<typeof moderationConfigSchema> = {
  enabled: false,
  protectedRoles: [],
  notifyDm: false,
  appealUrl: '',
  muteRole: null,
  removeOnMute: [],
  escalation: [],
};
export const modLogConfigSchema = z.object({
  enabled: z.boolean(),
  channelId: snowflakeId.nullable(),
  actions: z.array(moderationActionSchema).max(20),
  templates: z.partialRecord(moderationActionSchema, blocksSchema).default({}),
  externalEvents: z.boolean(),
});
export const initialModLogConfig: z.infer<typeof modLogConfigSchema> = {
  enabled: false,
  channelId: null,
  actions: moderationActionSchema.options.filter((action) => action !== 'note'),
  templates: {},
  externalEvents: false,
};
export type ModerationCase = {
  id: number;
  operation_id: string;
  action: ModerationAction;
  target: string;
  actor: string;
  reason: string;
  duration: number | null;
  source: string;
  state: string;
  created_at: number;
  expires_at: number | null;
  confirmed_at: number | null;
  updated_at: number;
  detail: string;
  error: string | null;
  revision: number;
  revoked: number;
};
export const actionTitles: Record<ModerationAction, string> = {
  warn: 'Предупреждение',
  note: 'Заметка',
  kick: 'Исключение',
  ban: 'Блокировка',
  tempban: 'Временная блокировка',
  softban: 'Softban',
  unban: 'Снятие блокировки',
  timeout: 'Тайм-аут',
  untimeout: 'Снятие тайм-аута',
  'role-mute': 'Ролевой мут',
  unmute: 'Снятие мута',
  purge: 'Очистка сообщений',
  lock: 'Закрытие канала',
  unlock: 'Открытие канала',
};
