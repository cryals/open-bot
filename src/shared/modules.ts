import { z } from 'zod';
import { blockSchema, uniqueBlockIds } from './blocks.js';

export const snowflakeId = z.string().regex(/^\d{17,20}$/);
export const moduleId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
export const accessSchema = z.object({
  admin: z.boolean(),
  ticketManage: z.boolean(),
  ticketView: z.boolean(),
});
export type Access = z.infer<typeof accessSchema>;
const roleIds = z.array(snowflakeId).max(20);
export const blocksSchema = z
  .array(blockSchema)
  .min(1)
  .max(30)
  .refine(uniqueBlockIds, 'Повторяющиеся ID блоков');
export const serverSchema = z.object({
  id: moduleId,
  name: z.string().trim().min(1).max(150),
  address: z.string().trim().min(1).max(500),
});
export const serverConfigSchema = z
  .object({ servers: z.array(serverSchema).max(30) })
  .refine(
    (value) => new Set(value.servers.map((server) => server.id)).size === value.servers.length,
    'Повторяющиеся серверы',
  );
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type GameServer = z.infer<typeof serverSchema>;
export const watchdogServerSchema = serverSchema.extend({
  instance: moduleId,
  tokenEnv: z.string().regex(/^WATCHDOG_TOKEN_[A-Z0-9_]{1,60}$/),
});
export const watchdogConfigSchema = z
  .object({ servers: z.array(watchdogServerSchema).max(30) })
  .refine(
    (value) => new Set(value.servers.map((server) => server.id)).size === value.servers.length,
    'Повторяющиеся серверы',
  );
export type WatchdogServer = z.infer<typeof watchdogServerSchema>;
export type WatchdogConfig = z.infer<typeof watchdogConfigSchema>;
export const powerActionSchema = z.enum(['restart', 'update', 'stop', 'revert']);
export type PowerAction = z.infer<typeof powerActionSchema>;
export const ticketCategorySchema = z.object({
  id: moduleId,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300),
  emoji: z.string().max(60).default(''),
  channelName: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[\p{L}\p{N}_{}-]+$/u)
    .refine(
      (value) => !value.replaceAll('{id}', '').replaceAll('{user}', '').match(/[{}]/),
      'Используйте только {id} и {user}',
    )
    .default('ticket-{id}'),
  enabled: z.boolean(),
  parentId: snowflakeId,
  supportRoles: roleIds,
  mentionRole: snowflakeId.nullable(),
  intro: blocksSchema,
  questions: z
    .array(z.object({ id: moduleId, label: z.string().min(1).max(45), required: z.boolean() }))
    .max(5)
    .refine(
      (questions) => new Set(questions.map((question) => question.id)).size === questions.length,
      'Повторяющиеся ID вопросов',
    ),
});
export const ticketConfigSchema = z
  .object({
    enabled: z.boolean(),
    fullRoleId: snowflakeId.default('1565440922336886876'),
    viewRoleId: snowflakeId.default('1565620276916658276'),
    staffChannelId: snowflakeId.nullable(),
    maxAttachmentMb: z.number().int().min(1).max(25).default(25),
    maxArchiveMb: z.number().int().min(100).max(100000).default(10000),
    panel: blocksSchema,
    categories: z.array(ticketCategorySchema).max(25),
  })
  .refine(
    (value) => new Set(value.categories.map((category) => category.id)).size === value.categories.length,
    'Повторяющиеся категории',
  );
export type TicketConfig = z.infer<typeof ticketConfigSchema>;
export type TicketCategory = z.infer<typeof ticketCategorySchema>;
export const initialTicketConfig: TicketConfig = {
  enabled: false,
  fullRoleId: '1565440922336886876',
  viewRoleId: '1565620276916658276',
  staffChannelId: null,
  maxAttachmentMb: 25,
  maxArchiveMb: 10000,
  panel: [{ id: 'ticket-panel', type: 'text', content: '# Поддержка\nВыберите категорию обращения.' }],
  categories: [],
};
export type TicketRow = {
  id: number;
  author_id: string;
  category_id: string;
  state: string;
  stage: string;
  channel_id: string | null;
  thread_id: string | null;
  staff_channel_id: string | null;
  staff_message_id: string | null;
  control_message_id: string | null;
  assignee: string | null;
  participants: string;
  form: string;
  reason: string | null;
  closed_by: string | null;
  created_at: number;
  closed_at: number | null;
  expires_at: number | null;
  next_at: number;
  attempts: number;
  error: string | null;
  archive_gap: string | null;
  first_response_at: number | null;
};
