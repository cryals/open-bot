import { z } from 'zod';
import { PermissionFlagsBits as P } from 'discord.js';
import { communityDefinitions, type CommunityModuleId } from '../shared/community.js';
import type { ApplicationSettings } from '../shared/settings.js';
import type { ModuleContext } from './runtime/types.js';
import { CommunityStore } from './community-store.js';
import { ApplicationSettingsStore } from './application-settings.js';
import { GuildAuthority } from './authority.js';
import { requireCapability } from './access.js';
import { canonicalSource } from './modules/subscriptions/providers.js';
import { restPort } from './module-http.js';
import { HttpError } from './errors.js';
import { JobStore } from './jobs.js';
import { nativeTrigger } from './modules/automod/native.js';
import { automodSchema } from '../shared/community.js';

export const moduleIntents: Partial<Record<CommunityModuleId, (keyof ApplicationSettings['gateway'])[]>> = {
  automod: ['messages', 'messageContent'],
  autoban: ['members'],
  'anti-raid': ['members'],
  slowmode: ['messages', 'messageContent'],
  'role-menus': ['reactions'],
  autoresponder: ['messages', 'messageContent'],
  starboard: ['messages', 'messageContent', 'reactions'],
};
export const modulePermissions: Record<CommunityModuleId, bigint[]> = {
  automod: [P.ViewChannel, P.ManageMessages],
  autoban: [P.BanMembers],
  'anti-raid': [P.ModerateMembers],
  slowmode: [P.ManageMessages],
  'role-menus': [P.ManageRoles, P.SendMessages],
  autoresponder: [P.SendMessages, P.AddReactions],
  'custom-commands': [P.SendMessages],
  forms: [P.SendMessages],
  giveaways: [P.SendMessages],
  subscriptions: [P.SendMessages, P.EmbedLinks],
  starboard: [P.ReadMessageHistory, P.SendMessages],
  'guild-backup': [P.ReadMessageHistory],
};
const reserved = new Set([
  'ping',
  'status',
  'help',
  'info',
  'send-info',
  'ticket',
  'ticket-panel',
  'ticket-manage',
  'metrics',
  'server-status',
  'server-config',
  'watchdog',
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
  'warnings',
  'case',
  'automod',
  'autoban',
  'raid',
  'slowmode',
  'role-panel',
  'autoresponder',
  'custom',
  'form',
  'giveaway',
  'feed',
  'starboard',
  'backup',
]);

/** Single write boundary used by HTTP and slash commands. Auth never comes from the config cache. */
export async function saveCommunityConfiguration(
  context: ModuleContext,
  id: CommunityModuleId,
  document: unknown,
  version: number,
  actor: { userId: string; name: string },
) {
  const { store, discord, config, activity } = context,
    definition = communityDefinitions[id];
  await requireCapability(discord, store, config, actor.userId, definition.capability);
  const configs = new CommunityStore(store),
    schema = definition.schema as z.ZodType,
    parsed = schema.parse(document) as Record<string, unknown>;
  let required = moduleIntents[id] || [];
  if (id === 'slowmode' && (parsed.rules as { mode: string }[]).every((rule) => rule.mode === 'discord'))
    required = [];
  const applied = new ApplicationSettingsStore(store, config).appliedGateway();
  if (parsed.enabled && required.some((key) => !applied?.[key]))
    throw new HttpError(409, 'Включите необходимые события в настройках приложения и перезапустите Bot');
  const channels = new Set<string>(),
    roles = new Set<string>();
  const channelKeys = new Set([
    'channelId',
    'channels',
    'sourceChannels',
    'exceptChannels',
    'excludedChannels',
    'destination',
    'eventChannel',
  ]);
  const references = (value: unknown, key = '') => {
    if (typeof value === 'string' && /^\d{17,20}$/.test(value)) {
      if (channelKeys.has(key)) channels.add(value);
      else if (/roles?$|roleId$/i.test(key)) roles.add(value);
      return;
    }
    if (Array.isArray(value)) for (const item of value) references(item, key);
    else if (value && typeof value === 'object')
      for (const [name, item] of Object.entries(value)) references(item, name);
  };
  references(parsed);
  const authority = new GuildAuthority(config, discord, store),
    auth = await authority.load(actor.userId);
  for (const role of roles)
    if (!auth.roles.some((item) => item.id === role))
      throw new HttpError(400, 'Роль отсутствует на настроенном сервере');
  if (channels.size) {
    const current = (await restPort(discord).get(`/guilds/${config.guildId}/channels`, {
      signal: AbortSignal.timeout(10000),
    })) as { id: string }[];
    for (const channel of channels)
      if (!current.some((item) => item.id === channel))
        throw new HttpError(400, 'Канал отсутствует на настроенном сервере');
  }
  const requiredPermissions = new Set<bigint>(),
    actionPermissions: Record<string, bigint> = {
      delete: P.ManageMessages,
      warn: P.ModerateMembers,
      timeout: P.ModerateMembers,
      kick: P.KickMembers,
      ban: P.BanMembers,
    };
  if (id === 'automod')
    for (const rule of automodSchema.parse(parsed).rules) if (rule.native) nativeTrigger(rule);
  if (id === 'automod' || id === 'autoban')
    for (const rule of parsed.rules as {
      enabled: boolean;
      observe: boolean;
      native?: boolean;
      action: string;
      roles?: string[];
      values?: string[];
    }[]) {
      if (rule.enabled && !rule.observe && actionPermissions[rule.action])
        requiredPermissions.add(actionPermissions[rule.action]);
      if (rule.native) {
        requiredPermissions.add(P.ManageGuild);
        if (parsed.enabled && !applied?.autoModeration)
          throw new HttpError(409, 'Включите Gateway Auto Moderation и перезапустите Bot');
      }
    }
  if (id === 'anti-raid' && parsed.automatic) {
    if (actionPermissions[String(parsed.action)])
      requiredPermissions.add(actionPermissions[String(parsed.action)]);
    if (parsed.action === 'quarantine') requiredPermissions.add(P.ManageRoles);
    if ((parsed.channels as string[]).length) requiredPermissions.add(P.ManageChannels);
  }
  if (id === 'slowmode')
    for (const rule of parsed.rules as { mode: string }[])
      requiredPermissions.add(rule.mode === 'discord' ? P.ManageChannels : P.ManageMessages);
  const deliveryObjects =
    id === 'autoresponder'
      ? parsed.rules
      : id === 'custom-commands'
        ? parsed.commands
        : id === 'subscriptions'
          ? parsed.feeds
          : [];
  if (
    (deliveryObjects as { delivery?: { mentions: { everyone: boolean; roles: boolean } } }[]).some(
      (entry) => entry.delivery?.mentions.everyone || entry.delivery?.mentions.roles,
    )
  )
    requiredPermissions.add(P.MentionEveryone);
  for (const permission of requiredPermissions)
    if (!auth.has(auth.executor, permission) || !auth.has(auth.bot, permission))
      throw new HttpError(403, 'Для выбранных действий недостаточно фактических прав Discord');
  if (id === 'subscriptions')
    for (const feed of parsed.feeds as { provider: Parameters<typeof canonicalSource>[0]; source: string }[])
      feed.source = canonicalSource(feed.provider, feed.source);
  if (id === 'custom-commands') {
    const commands = parsed.commands as {
      name: string;
      safeRoles: string[];
      private: boolean;
      deleteAfter: number;
    }[];
    if (
      new Set(commands.map((command) => command.name)).size !== commands.length ||
      commands.some((command) => reserved.has(command.name))
    )
      throw new HttpError(400, 'Имя команды занято системной или другой командой');
    for (const command of commands) authority.validatePublicRoles(auth, command.safeRoles, command.safeRoles);
    if (commands.some((command) => command.private && command.deleteAfter > 840))
      throw new HttpError(
        400,
        'Личный ответ можно удалить в течение 14 минут; срок ограничен токеном Discord',
      );
  }
  if (id === 'role-menus')
    for (const panel of parsed.panels as { options: { id: string; roleId: string }[] }[]) {
      const ids = panel.options.map((option) => option.id),
        roleIds = panel.options.map((option) => option.roleId);
      if (new Set(ids).size !== ids.length || new Set(roleIds).size !== roleIds.length)
        throw new HttpError(400, 'Варианты и роли панели должны быть уникальными');
      authority.validatePublicRoles(auth, roleIds, roleIds);
    }
  if (id === 'forms')
    for (const form of parsed.forms as {
      appeal: boolean;
      membersOnly: boolean;
      grantRole: string | null;
      questions: { id: string; type: string; choices: string[] }[];
    }[]) {
      if (form.appeal && form.membersOnly)
        throw new HttpError(400, 'Для апелляций без членства выключите membersOnly');
      if (new Set(form.questions.map((question) => question.id)).size !== form.questions.length)
        throw new HttpError(400, 'ID вопросов должны быть уникальными');
      for (const question of form.questions)
        if (
          ['single', 'multiple'].includes(question.type) &&
          (!question.choices.length || new Set(question.choices).size !== question.choices.length)
        )
          throw new HttpError(400, 'Добавьте неповторяющиеся варианты выбора');
      if (form.grantRole) authority.validatePublicRoles(auth, [form.grantRole], [form.grantRole]);
    }
  if (id === 'anti-raid' && parsed.quarantineRole)
    authority.validatePublicRoles(auth, [String(parsed.quarantineRole)], [String(parsed.quarantineRole)]);
  const before = configs.config(id, true);
  const saved = configs.save(id, parsed, version);
  if (
    id === 'automod' &&
    ((parsed.rules as { native: boolean }[]).some((rule) => rule.native) ||
      configs.state('automod', 'native'))
  )
    new JobStore(store).enqueue(
      'native-sync:' + saved.version,
      'community.native-sync',
      'native-sync:' + saved.version,
      { actor: actor.userId },
    );
  activity.record(actor, {
    kind: 'community.settings',
    target: id,
    summary: 'Изменены настройки ' + definition.title,
    before: before.document,
    after: saved.document,
  });
  return saved;
}
