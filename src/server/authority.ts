import {
  PermissionFlagsBits,
  type APIGuild,
  type APIGuildMember,
  type APIRole,
  type APIChannel,
} from 'discord.js';
import type { Config } from './config.js';
import type { DiscordPort } from './discord.js';
import { restPort } from './module-http.js';
import { HttpError } from './errors.js';
import type { Store } from './store.js';
import { ApplicationSettingsStore } from './application-settings.js';
import { ModuleStore } from './module-store.js';
import { ticketConfigSchema, initialTicketConfig } from '../shared/modules.js';
import { formsSchema, giveawayConfigSchema } from '../shared/community.js';
import { z } from 'zod';
import { snowflakeId } from '../shared/modules.js';
const guildIdentity = z.object({ id: snowflakeId, owner_id: snowflakeId }).passthrough();
const memberIdentity = z
  .object({ user: z.object({ id: snowflakeId }).passthrough(), roles: z.array(snowflakeId) })
  .passthrough();
const roleIdentity = z
  .object({ id: snowflakeId, permissions: z.string().regex(/^\d{1,25}$/), position: z.number().int() })
  .passthrough();
export class GuildAuthority {
  constructor(
    private config: Config,
    private discord: DiscordPort,
    private store: Store,
  ) {}
  async load(actor: string, target?: string) {
    const rest = restPort(this.discord),
      signal = AbortSignal.timeout(10000);
    const [rawGuild, rawRoles, rawExecutor, rawBot] = await Promise.all([
      rest.get(`/guilds/${this.config.guildId}`, { signal }) as Promise<APIGuild>,
      rest.get(`/guilds/${this.config.guildId}/roles`, { signal }) as Promise<APIRole[]>,
      rest.get(`/guilds/${this.config.guildId}/members/${actor}`, { signal }) as Promise<APIGuildMember>,
      rest.get(`/guilds/${this.config.guildId}/members/${this.config.clientId}`, {
        signal,
      }) as Promise<APIGuildMember>,
    ]);
    const guild = guildIdentity.parse(rawGuild) as unknown as APIGuild,
      roles = z.array(roleIdentity).parse(rawRoles) as unknown as APIRole[],
      executor = memberIdentity.parse(rawExecutor) as unknown as APIGuildMember,
      bot = memberIdentity.parse(rawBot) as unknown as APIGuildMember;
    const bits = (member: APIGuildMember) =>
      roles
        .filter((role) => role.id === guild.id || member.roles.includes(role.id))
        .reduce((sum, role) => sum | BigInt(role.permissions), 0n);
    const top = (member: APIGuildMember) =>
      roles
        .filter((role) => member.roles.includes(role.id))
        .sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))[0];
    const higher = (left: APIRole | undefined, right: APIRole | undefined) =>
      !!left &&
      (!right ||
        left.position > right.position ||
        (left.position === right.position && BigInt(left.id) < BigInt(right.id)));
    const has = (member: APIGuildMember, permission: bigint) =>
      member.user?.id === guild.owner_id ||
      (bits(member) & PermissionFlagsBits.Administrator) !== 0n ||
      (bits(member) & permission) === permission;
    let subject: APIGuildMember | undefined;
    if (target)
      try {
        subject = (await rest.get(`/guilds/${guild.id}/members/${target}`, { signal })) as APIGuildMember;
      } catch (error) {
        if ((error as { code?: number }).code !== 10007) throw error;
      }
    return { guild, roles, executor, bot, subject, bits, top, higher, has };
  }
  async action(
    actor: string,
    target: string,
    permission: bigint,
    protectedRoles: string[] = [],
    allowAbsent = false,
  ) {
    const auth = await this.load(actor, target);
    if (!auth.has(auth.executor, permission) || !auth.has(auth.bot, permission))
      throw new HttpError(403, 'У исполнителя или бота отсутствуют необходимые права Discord');
    if (target === actor || target === this.config.clientId || target === auth.guild.owner_id)
      throw new HttpError(403, 'Недопустимая цель');
    if (!auth.subject && !allowAbsent) throw new HttpError(404, 'Участник не найден на сервере');
    if (auth.subject) {
      if (auth.subject.roles.some((role) => protectedRoles.includes(role)))
        throw new HttpError(403, 'Участник защищён настройками модерации');
      if (
        !auth.higher(auth.top(auth.bot), auth.top(auth.subject)) ||
        (actor !== auth.guild.owner_id && !auth.higher(auth.top(auth.executor), auth.top(auth.subject)))
      )
        throw new HttpError(403, 'Иерархия ролей запрещает действие');
    }
    return auth;
  }
  async channel(actor: string, id: string, permission: bigint) {
    const auth = await this.load(actor),
      channel = (await restPort(this.discord).get(`/channels/${id}`, {
        signal: AbortSignal.timeout(10000),
      })) as APIChannel;
    if (!('guild_id' in channel) || channel.guild_id !== this.config.guildId)
      throw new HttpError(400, 'Канал другого сервера');
    const effective = (member: APIGuildMember) => {
      if (auth.has(member, PermissionFlagsBits.Administrator)) return true;
      let value = auth.bits(member);
      const overwrites = 'permission_overwrites' in channel ? channel.permission_overwrites || [] : [];
      const everyone = overwrites.find((item) => item.id === auth.guild.id);
      if (everyone) value = (value & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
      const matches = overwrites.filter((item) => item.type === 0 && member.roles.includes(item.id));
      value =
        (value & ~matches.reduce((sum, item) => sum | BigInt(item.deny), 0n)) |
        matches.reduce((sum, item) => sum | BigInt(item.allow), 0n);
      const own = overwrites.find((item) => item.type === 1 && item.id === member.user?.id);
      if (own) value = (value & ~BigInt(own.deny)) | BigInt(own.allow);
      return (value & permission) === permission;
    };
    if (!effective(auth.executor) || !effective(auth.bot))
      throw new HttpError(403, 'Недостаточно прав в канале');
    return { auth, channel };
  }
  async safeRole(actor: string, target: string, roleId: string, allowlist: string[], add: boolean) {
    const auth = await this.load(actor, target);
    this.validatePublicRoles(auth, [roleId], allowlist);
    if (!auth.subject) throw new HttpError(404, 'Участник отсутствует');
    await restPort(this.discord)[add ? 'put' : 'delete'](
      `/guilds/${auth.guild.id}/members/${target}/roles/${roleId}`,
      { signal: AbortSignal.timeout(10000) },
    );
  }
  validatePublicRoles(auth: Awaited<ReturnType<GuildAuthority['load']>>, ids: string[], allowlist: string[]) {
    const modules = new ModuleStore(this.store),
      app = new ApplicationSettingsStore(this.store, this.config).get().document,
      ticket = modules.get('tickets', ticketConfigSchema, initialTicketConfig).document,
      forms = modules.get('forms', formsSchema, formsSchema.parse({})).document,
      giveaway = modules.get('giveaways', giveawayConfigSchema, giveawayConfigSchema.parse({})).document;
    const privileged = new Set([
      this.store.getSettings().adminRoleId,
      ticket.fullRoleId,
      ticket.viewRoleId,
      ...Object.values(app.grants).flat(),
      ...forms.forms.flatMap((form) => form.reviewRoles),
      ...giveaway.managerRoles,
    ]);
    for (const id of ids) {
      const role = auth.roles.find((role) => role.id === id);
      if (
        !allowlist.includes(id) ||
        privileged.has(id) ||
        !role ||
        role.id === this.config.guildId ||
        role.managed ||
        (BigInt(role.permissions) & publicRoleForbiddenPermissions) !== 0n ||
        !auth.higher(auth.top(auth.bot), role) ||
        !auth.has(auth.bot, PermissionFlagsBits.ManageRoles)
      )
        throw new HttpError(
          403,
          'Роль недоступна для публичной выдачи или предоставляет административный доступ',
        );
    }
  }
}
export const publicRoleForbiddenPermissions =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.ManageWebhooks |
  PermissionFlagsBits.MentionEveryone |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageThreads |
  PermissionFlagsBits.ManageNicknames |
  PermissionFlagsBits.ViewAuditLog |
  PermissionFlagsBits.ManageEvents |
  PermissionFlagsBits.ManageGuildExpressions |
  PermissionFlagsBits.MuteMembers |
  PermissionFlagsBits.DeafenMembers |
  PermissionFlagsBits.MoveMembers;
