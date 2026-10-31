import { z } from 'zod';
import { snowflakeId, moduleId, blocksSchema } from './modules.js';
import { templateBlocksSchema } from './templates.js';
import { messageSchema } from './blocks.js';
const deliverySchema = z
  .object({
    silent: z.boolean().default(false),
    mentions: messageSchema.shape.mentions.default({ users: false, roles: false, everyone: false }),
  })
  .default({ silent: false, mentions: { users: false, roles: false, everyone: false } });
const ids = z.array(snowflakeId).max(100);
const scope = {
  channels: ids.default([]),
  roles: ids.default([]),
  exceptChannels: ids.default([]),
  exceptRoles: ids.default([]),
};
const match = z.enum(['exact', 'contains', 'all']);
const messageAction = z.enum(['notify', 'delete', 'warn', 'timeout', 'kick', 'ban', 'review']);
export const automodSchema = z.object({
  phishingSource: z.enum(['none', 'sinking-yachts']).default('none'),
  enabled: z.boolean().default(false),
  evidenceDays: z.number().int().min(1).max(30).default(7),
  phishingDomains: z.array(z.string().max(253)).max(10000).default([]),
  phishingUpdatedAt: z.number().int().nullable().default(null),
  rules: z
    .array(
      z.object({
        id: moduleId,
        name: z.string().min(1).max(80),
        enabled: z.boolean().default(true),
        priority: z.number().int().default(0),
        filter: z.enum([
          'words',
          'domains',
          'invites',
          'phishing',
          'rate',
          'duplicates',
          'repeated-chars',
          'repeated-words',
          'caps',
          'mentions',
          'emoji',
          'attachments',
          'stickers',
          'length',
          'lines',
          'spoilers',
          'zalgo',
          'files',
          'media-only',
          'youtube-only',
          'honeypot',
        ]),
        values: z.array(z.string().max(200)).max(200).default([]),
        allowlist: z.array(z.string().max(200)).max(200).default([]),
        wholeWords: z.boolean().default(false),
        threshold: z.number().min(1).max(100000).default(5),
        windowSeconds: z.number().int().min(1).max(86400).default(10),
        minLength: z.number().int().min(1).max(4000).default(10),
        observe: z.boolean().default(true),
        native: z.boolean().default(false),
        action: messageAction.default('delete'),
        duration: z.number().int().min(1).max(2419200).default(600),
        eventChannel: snowflakeId.nullable().default(null),
        response: templateBlocksSchema.optional(),
        ...scope,
      }),
    )
    .max(100)
    .default([]),
});
export const autobanSchema = z.object({
  enabled: z.boolean().default(false),
  rules: z
    .array(
      z.object({
        id: moduleId,
        enabled: z.boolean().default(true),
        filter: z.enum(['account-age', 'name', 'name-invite']),
        value: z.string().max(200).default(''),
        seconds: z.number().int().min(1).max(31536000).default(86400),
        match: match.default('contains'),
        caseSensitive: z.boolean().default(false),
        exceptUsers: ids.default([]),
        exceptRoles: ids.default([]),
        observe: z.boolean().default(true),
        action: z.enum(['kick', 'ban', 'timeout']).default('ban'),
        duration: z.number().int().min(1).max(2419200).default(600),
      }),
    )
    .max(100)
    .default([]),
});
export const antiRaidSchema = z.object({
  enabled: z.boolean().default(false),
  threshold: z.number().int().min(2).max(10000).default(10),
  windowSeconds: z.number().int().min(1).max(3600).default(30),
  youngAccountSeconds: z.number().int().min(0).max(31536000).default(86400),
  quietSeconds: z.number().int().min(10).max(86400).default(300),
  automatic: z.boolean().default(false),
  action: z.enum(['notify', 'quarantine', 'timeout', 'kick', 'ban']).default('notify'),
  quarantineRole: snowflakeId.nullable().default(null),
  exceptRoles: ids.default([]),
  channels: ids.default([]),
  slowmodeSeconds: z.number().int().min(0).max(21600).default(30),
  lockdown: z.boolean().default(false),
  eventChannel: snowflakeId.nullable().default(null),
});
export const slowmodeSchema = z.object({
  enabled: z.boolean().default(false),
  rules: z
    .array(
      z.object({
        id: moduleId,
        channelId: snowflakeId,
        mode: z.enum(['discord', 'user', 'channel']),
        seconds: z.number().int().min(1).max(21600),
        expiresAt: z.number().int().nullable().default(null),
        exceptRoles: ids.default([]),
      }),
    )
    .max(100)
    .default([]),
});
export const roleMenusSchema = z.object({
  enabled: z.boolean().default(false),
  panels: z
    .array(
      z.object({
        id: moduleId,
        title: z.string().min(1).max(80),
        channelId: snowflakeId,
        messageId: snowflakeId.nullable().default(null),
        kind: z.enum(['buttons', 'select', 'reactions']).default('buttons'),
        mode: z.enum(['toggle', 'add-only', 'remove-only', 'single', 'multiple', 'random']).default('toggle'),
        requiredRoles: ids.default([]),
        forbiddenRoles: ids.default([]),
        maxSelected: z.number().int().min(1).max(25).default(25),
        blocks: blocksSchema,
        options: z
          .array(
            z.object({
              id: moduleId,
              label: z.string().min(1).max(80),
              roleId: snowflakeId,
              emoji: z.string().max(100).default(''),
            }),
          )
          .min(1)
          .max(25),
      }),
    )
    .max(50)
    .default([]),
});
export const autoresponderSchema = z.object({
  enabled: z.boolean().default(false),
  rules: z
    .array(
      z.object({
        id: moduleId,
        enabled: z.boolean().default(true),
        trigger: z.string().max(1000),
        delivery: deliverySchema,
        match: match.default('contains'),
        caseSensitive: z.boolean().default(false),
        priority: z.number().int().default(0),
        blocks: templateBlocksSchema.optional(),
        reactions: z.array(z.string().max(100)).max(10).default([]),
        userCooldown: z.number().int().min(0).max(86400).default(10),
        channelCooldown: z.number().int().min(0).max(86400).default(0),
        deleteAfter: z.number().int().min(0).max(86400).default(0),
        destination: snowflakeId.nullable().default(null),
        ...scope,
      }),
    )
    .max(100)
    .default([]),
});
export const customCommandsSchema = z.object({
  enabled: z.boolean().default(false),
  commands: z
    .array(
      z.object({
        id: moduleId,
        name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        description: z.string().min(1).max(100),
        enabled: z.boolean().default(true),
        registerSlash: z.boolean().default(false),
        delivery: deliverySchema,
        private: z.boolean().default(true),
        roles: ids.default([]),
        channels: ids.default([]),
        cooldown: z.number().int().min(0).max(86400).default(10),
        deleteAfter: z.number().int().min(0).max(86400).default(0),
        arguments: z
          .array(
            z.object({
              name: moduleId,
              description: z.string().min(1).max(100),
              type: z.enum(['string', 'integer', 'user', 'channel', 'role']).default('string'),
              required: z.boolean().default(false),
            }),
          )
          .max(10)
          .default([]),
        responses: z.array(templateBlocksSchema).min(1).max(20),
        actions: z
          .array(
            z.object({
              type: z.enum(['send', 'dm', 'role-add', 'role-remove', 'form', 'ticket']),
              value: z.string().max(200),
              requiredRole: snowflakeId.nullable().default(null),
            }),
          )
          .max(10)
          .default([]),
        safeRoles: ids.default([]),
      }),
    )
    .max(50)
    .default([]),
});
export const formSchema = z.object({
  id: moduleId,
  title: z.string().min(1).max(150),
  description: z.string().max(1000).default(''),
  enabled: z.boolean().default(true),
  membersOnly: z.boolean().default(true),
  appeal: z.boolean().default(false),
  anonymous: z.boolean().default(false),
  onePerUser: z.boolean().default(true),
  cooldown: z.number().int().min(0).max(2592000).default(3600),
  opensAt: z.number().int().nullable().default(null),
  closesAt: z.number().int().nullable().default(null),
  retentionDays: z.number().int().min(1).max(365).default(180),
  roles: ids.default([]),
  reviewRoles: ids.default([]),
  channelId: snowflakeId,
  thread: z.boolean().default(false),
  mentionRole: snowflakeId.nullable().default(null),
  grantRole: snowflakeId.nullable().default(null),
  ticketCategory: moduleId.nullable().default(null),
  questions: z
    .array(
      z.object({
        id: moduleId,
        label: z.string().min(1).max(100),
        type: z.enum(['short', 'long', 'single', 'multiple']),
        required: z.boolean().default(true),
        choices: z.array(z.string().min(1).max(100)).max(25).default([]),
      }),
    )
    .min(1)
    .max(50),
});
export const formsSchema = z.object({
  enabled: z.boolean().default(false),
  forms: z.array(formSchema).max(100).default([]),
});
export const giveawayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  managerRoles: ids.default([]),
});
export const giveawaySchema = z
  .object({
    prize: z.string().min(1).max(200),
    image: z
      .url()
      .refine((value) => new URL(value).protocol === 'https:')
      .nullable()
      .default(null),
    channelId: snowflakeId,
    startsAt: z.number().int(),
    endsAt: z.number().int(),
    winners: z.number().int().min(1).max(100),
    requiredRoles: ids.default([]),
    blockedRoles: ids.default([]),
    minAccountDays: z.number().int().min(0).max(3650).default(0),
    dailyBonus: z.number().int().min(0).max(10).default(0),
    referralBonus: z.number().int().min(0).max(10).default(0),
    maxChances: z.number().int().min(1).max(100).default(1),
    rewardRole: snowflakeId.nullable().default(null),
    notifyDm: z.boolean().default(false),
  })
  .refine((value) => value.endsAt > value.startsAt, 'Окончание должно быть позже начала');
export const starboardSchema = z.object({
  enabled: z.boolean().default(false),
  boards: z
    .array(
      z.object({
        id: moduleId,
        channelId: snowflakeId,
        emoji: z.string().min(1).max(100).default('⭐'),
        threshold: z.number().int().min(1).max(10000).default(3),
        sourceChannels: ids.min(1),
        voterRoles: ids.default([]),
        allowBots: z.boolean().default(false),
        allowSelf: z.boolean().default(false),
        belowThreshold: z.enum(['keep', 'remove']).default('remove'),
      }),
    )
    .max(20)
    .default([]),
});
export const feedSchema = z.object({
  delivery: deliverySchema,
  id: moduleId,
  provider: z.enum(['youtube', 'twitch', 'kick', 'tiktok', 'reddit', 'vk']),
  source: z.string().min(1).max(300),
  channelId: snowflakeId,
  enabled: z.boolean().default(true),
  types: z
    .array(z.enum(['video', 'live', 'post']))
    .min(1)
    .default(['video', 'live', 'post']),
  keywords: z.array(z.string().max(100)).max(50).default([]),
  flairs: z.array(z.string().max(100)).max(50).default([]),
  attachmentTypes: z.array(z.string().max(30)).max(20).default([]),
  allowNsfw: z.boolean().default(false),
  stripHashtags: z.boolean().default(false),
  blocks: templateBlocksSchema.optional(),
  backfill: z.number().int().min(0).max(20).default(0),
});
export const subscriptionsSchema = z.object({
  enabled: z.boolean().default(false),
  youtubeLiveSearchSeconds: z.number().int().min(900).max(86400).default(3600),
  youtubeSearchDailyBudget: z.number().int().min(1).max(10000).default(90),
  feeds: z.array(feedSchema).max(100).default([]),
});
export const guildBackupSchema = z.object({
  enabled: z.boolean().default(false),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('04:00'),
  timezone: z
    .string()
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Неизвестный часовой пояс')
    .default('Europe/Moscow'),
  maxFileMb: z.number().int().min(1).max(25).default(25),
  maxArchiveMb: z.number().int().min(16).max(64).default(64),
  includeMembers: z.boolean().default(false),
  includeMessages: z.boolean().default(true),
  messagesPerChannel: z.number().int().min(1).max(100).default(20),
  keepCopies: z.number().int().min(1).max(30).default(3),
  excludedChannels: ids.default([]),
});
export const communityDefinitions = {
  automod: {
    title: 'AutoMod',
    description: 'Фильтры сообщений, наблюдение, доказательства и автоматические санкции.',
    schema: automodSchema,
    capability: 'moderationManage',
  },
  autoban: {
    title: 'AutoBan',
    description: 'Правила новых входов по возрасту аккаунта, имени и инвайтам.',
    schema: autobanSchema,
    capability: 'moderationManage',
  },
  'anti-raid': {
    title: 'AntiRaid',
    description: 'Защитный режим при массовых входах, карантин и временные ограничения каналов.',
    schema: antiRaidSchema,
    capability: 'moderationManage',
  },
  slowmode: {
    title: 'Slowmode',
    description: 'Интервал сообщений Discord и ограничения частоты силами бота.',
    schema: slowmodeSchema,
    capability: 'moderationManage',
  },
  'role-menus': {
    title: 'Панели ролей',
    description: 'Безопасная выдача ролей через кнопки, меню и реакции.',
    schema: roleMenusSchema,
    capability: 'rolesManage',
  },
  autoresponder: {
    title: 'Автоответы',
    description: 'Ответы и реакции на заданные фразы с приоритетами и cooldown.',
    schema: autoresponderSchema,
    capability: 'rolesManage',
  },
  'custom-commands': {
    title: 'Свои команды',
    description: 'Пользовательские slash-команды с параметрами, шаблонами и разрешёнными действиями.',
    schema: customCommandsSchema,
    capability: 'rolesManage',
  },
  forms: {
    title: 'Формы и апелляции',
    description: 'Приём заявок в Discord и через веб, обработка решений и апелляций.',
    schema: formsSchema,
    capability: 'formsManage',
  },
  giveaways: {
    title: 'Розыгрыши',
    description: 'Розыгрыши с условиями участия, сохраняемыми итогами и повторным выбором.',
    schema: giveawayConfigSchema,
    capability: 'giveawaysManage',
  },
  subscriptions: {
    title: 'Подписки',
    description: 'Анонсы YouTube, Twitch, Kick, TikTok, Reddit и VK с очередью доставки.',
    schema: subscriptionsSchema,
    capability: 'feedsManage',
  },
  starboard: {
    title: 'Starboard',
    description: 'Подборки сообщений по уникальным голосам с защитой приватных каналов.',
    schema: starboardSchema,
    capability: 'rolesManage',
  },
  'guild-backup': {
    title: 'Копии Discord-сервера',
    description: 'Ежедневные снимки guild и поэтапное восстановление ролей, каналов и сообщений.',
    schema: guildBackupSchema,
    capability: 'backupManage',
  },
} as const;
export type CommunityModuleId = keyof typeof communityDefinitions;
export const communityJobModules: Record<string, CommunityModuleId> = {
  'community.role-panel': 'role-menus',
  'community.native-sync': 'automod',
  'community.backup': 'guild-backup',
  'community.restore': 'guild-backup',
  'community.raid-start': 'anti-raid',
  'community.raid-stop': 'anti-raid',
  'community.giveaway-end': 'giveaways',
  'community.giveaway-cancel': 'giveaways',
  'community.giveaway-reroll': 'giveaways',
  'community.star-hide': 'starboard',
};
