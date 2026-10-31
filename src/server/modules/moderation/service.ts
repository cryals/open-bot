import { PermissionFlagsBits as P, type APIMessage, type APIGuildMember } from 'discord.js';
import { z } from 'zod';
import {
  initialModerationConfig,
  moderationConfigSchema,
  moderationRequestSchema,
  type ModerationCase,
  type ModerationRequest,
  type ModerationAction,
} from '../../../shared/moderation.js';
import type { Config } from '../../config.js';
import type { Store } from '../../store.js';
import type { DiscordPort } from '../../discord.js';
import type { ActivityService } from '../../activity.js';
import { ModuleStore } from '../../module-store.js';
import { restPort } from '../../module-http.js';
import { GuildAuthority } from '../../authority.js';
import { requireCapability } from '../../access.js';
import { HttpError } from '../../errors.js';
import { JobStore, domainEvent, type Job } from '../../jobs.js';
import { telemetry } from '../../telemetry.js';
const permissions: Record<ModerationAction, bigint> = {
  warn: P.ModerateMembers,
  note: P.ModerateMembers,
  kick: P.KickMembers,
  ban: P.BanMembers,
  tempban: P.BanMembers,
  softban: P.BanMembers,
  unban: P.BanMembers,
  timeout: P.ModerateMembers,
  untimeout: P.ModerateMembers,
  'role-mute': P.ManageRoles,
  unmute: P.ManageRoles,
  purge: P.ManageMessages,
  lock: P.ManageChannels,
  unlock: P.ManageChannels,
};
const channelActions = new Set(['purge', 'lock', 'unlock']);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 1500) : 'Discord request failed';
const knownMissing = (error: unknown, code: number) => (error as { code?: number }).code === code;
export class ModerationService {
  private configs: ModuleStore;
  readonly jobs: JobStore;
  private authority: GuildAuthority;
  private busy = false;
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly discord: DiscordPort,
    readonly activity: ActivityService,
    private onError: (error: unknown, scope: string) => void = () => {},
  ) {
    this.configs = new ModuleStore(store);
    this.jobs = new JobStore(store);
    this.authority = new GuildAuthority(config, discord, store);
  }
  settings() {
    return this.configs.get('moderation', moderationConfigSchema, initialModerationConfig);
  }
  list(target?: string, before?: number) {
    return this.store.sqlite
      .prepare(
        'SELECT * FROM moderation_cases WHERE (? IS NULL OR target=?) AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 100',
      )
      .all(target || null, target || null, before || null, before || null) as ModerationCase[];
  }
  get(id: number) {
    const row = this.store.sqlite.prepare('SELECT * FROM moderation_cases WHERE id=?').get(id) as
      ModerationCase | undefined;
    if (!row) throw new HttpError(404, 'Дело не найдено');
    return row;
  }
  history(id: number) {
    this.get(id);
    return this.store.sqlite.prepare('SELECT * FROM moderation_history WHERE case_id=? ORDER BY id').all(id);
  }
  private record(row: ModerationCase, actor: string, kind: string, detail: unknown) {
    this.store.sqlite
      .prepare('INSERT INTO moderation_history(case_id,actor,kind,document,created_at) VALUES(?,?,?,?,?)')
      .run(row.id, actor, kind, JSON.stringify(detail), Date.now());
    domainEvent(
      this.store,
      `${row.operation_id}:${row.revision}:${kind}`,
      row.operation_id,
      'moderation.changed',
      { caseId: row.id, revision: row.revision, kind },
    );
  }
  async save(document: unknown, version: number, actor: { userId: string; name: string }) {
    await requireCapability(this.discord, this.store, this.config, actor.userId, 'moderationManage');
    const parsed = moderationConfigSchema.parse(document),
      guild = await this.discord.info();
    for (const id of [
      ...parsed.protectedRoles,
      ...parsed.removeOnMute,
      ...(parsed.muteRole ? [parsed.muteRole] : []),
    ])
      if (!guild.roles.some((role) => role.id === id))
        throw new HttpError(400, 'Роль отсутствует на сервере');
    if (parsed.muteRole && parsed.removeOnMute.includes(parsed.muteRole))
      throw new HttpError(400, 'Нельзя удалять роль мута при включении мута');
    const before = this.settings();
    const authority = await this.authority.load(actor.userId);
    if (parsed.muteRole) this.authority.validatePublicRoles(authority, [parsed.muteRole], [parsed.muteRole]);
    for (const rule of parsed.escalation) {
      const permission = permissions[rule.action];
      if (!authority.has(authority.executor, permission) || !authority.has(authority.bot, permission))
        throw new HttpError(403, 'Недостаточно Discord-прав для эскалации');
    }
    const after = this.configs.save('moderation', moderationConfigSchema, parsed, version);
    this.activity.record(actor, {
      kind: 'moderation.settings',
      target: 'moderation',
      summary: 'Настройки модерации изменены',
      before: before.document,
      after: after.document,
    });
    return after;
  }
  private async validate(actor: string, input: ModerationRequest, expiry = false) {
    if (!this.settings().document.enabled && !expiry)
      throw new HttpError(409, 'Модерация выключена в настройках');
    if (input.action === 'timeout' && (!input.duration || input.duration > 2419200))
      throw new HttpError(400, 'Тайм-аут: от 1 секунды до 28 дней');
    if (input.action === 'tempban' && !input.duration)
      throw new HttpError(400, 'Укажите срок временного бана');
    if (channelActions.has(input.action))
      return this.authority.channel(actor, input.target, permissions[input.action] | P.ViewChannel);
    const auth = await this.authority.action(
      actor,
      input.target,
      permissions[input.action],
      this.settings().document.protectedRoles,
      ['ban', 'tempban', 'unban', 'softban'].includes(input.action),
    );
    if (input.action === 'timeout' && auth.subject && auth.has(auth.subject, P.Administrator))
      throw new HttpError(403, 'Discord не позволяет применять timeout к администратору');
    return auth;
  }
  async prepare(input: unknown, actor: { userId: string; name: string }, source = 'web') {
    await requireCapability(this.discord, this.store, this.config, actor.userId, 'moderationManage');
    return this.reserve(moderationRequestSchema.parse(input), actor.userId, source);
  }
  private async reserve(input: ModerationRequest, actor: string, source: string) {
    const existing = this.store.sqlite
      .prepare('SELECT * FROM moderation_cases WHERE operation_id=?')
      .get(input.operationId) as ModerationCase | undefined;
    if (existing) {
      if (existing.actor !== actor) throw new HttpError(403, 'Операция другого исполнителя');
      return existing;
    }
    await this.validate(actor, input, source === 'expiry');
    const detail: { input: ModerationRequest; messageIds?: string[] } = { input };
    if (input.action === 'purge') {
      if (!input.purge) throw new HttpError(400, 'Укажите параметры очистки');
      const messages: APIMessage[] = [];
      let before: string | undefined;
      while (messages.length < input.purge.count) {
        const page = (await restPort(this.discord).get(`/channels/${input.target}/messages`, {
          query: new URLSearchParams({
            limit: String(Math.min(100, input.purge.count - messages.length)),
            ...(before ? { before } : {}),
          }),
          signal: AbortSignal.timeout(10000),
        })) as APIMessage[];
        if (!page.length) break;
        messages.push(...page);
        before = page.at(-1)!.id;
      }
      const filter = input.purge;
      detail.messageIds = messages
        .filter(
          (message) =>
            (filter.includePinned || !message.pinned) &&
            (!filter.author || message.author.id === filter.author) &&
            (!filter.contains || message.content.includes(filter.contains)) &&
            (filter.type === 'all' ||
              (filter.type === 'bots' ? message.author.bot : message.attachments.length > 0)),
        )
        .map((message) => message.id);
    }
    const now = Date.now();
    const result = this.store.sqlite
      .prepare(
        "INSERT INTO moderation_cases(operation_id,action,target,actor,reason,duration,source,state,created_at,updated_at,detail) VALUES(?,?,?,?,?,?,?,'prepared',?,?,?)",
      )
      .run(
        input.operationId,
        input.action,
        input.target,
        actor,
        input.reason,
        input.duration,
        source,
        now,
        now,
        JSON.stringify(detail),
      );
    const row = this.get(Number(result.lastInsertRowid));
    this.record(row, actor, 'requested', { action: row.action, target: row.target });
    return row;
  }
  async enqueueSystem(input: Omit<ModerationRequest, 'operationId'>, operation: string, source: string) {
    // Only internal modules call this method; no HTTP route accepts source/actor overrides.
    const existing = this.store.sqlite
      .prepare('SELECT * FROM moderation_cases WHERE operation_id=?')
      .get(operation) as ModerationCase | undefined;
    if (existing) return existing;
    const row = await this.reserve({ ...input, operationId: operation }, this.config.clientId, source);
    this.confirmInternal(row);
    return this.get(row.id);
  }
  async confirm(id: number, actor: string) {
    await requireCapability(this.discord, this.store, this.config, actor, 'moderationManage');
    const row = this.get(id);
    if (row.actor !== actor) throw new HttpError(403, 'Подтверждение доступно только исполнителю');
    if (Date.now() - row.created_at > 90000) throw new HttpError(409, 'Подтверждение устарело');
    await this.validate(actor, moderationRequestSchema.parse(JSON.parse(row.detail).input));
    this.confirmInternal(row);
    return this.get(id);
  }
  private confirmInternal(row: ModerationCase) {
    this.store.sqlite
      .transaction(() => {
        if (
          !this.store.sqlite
            .prepare(
              "UPDATE moderation_cases SET state='queued',confirmed_at=?,updated_at=? WHERE id=? AND state='prepared'",
            )
            .run(Date.now(), Date.now(), row.id).changes
        )
          throw new HttpError(409, 'Операция уже подтверждена или отменена');
        this.jobs.enqueue(`moderation:${row.id}`, 'moderation.execute', row.operation_id, { id: row.id });
      })
      .immediate();
  }
  cancel(id: number, actor: string) {
    const row = this.get(id);
    if (row.actor !== actor) throw new HttpError(403, 'Операция другого исполнителя');
    if (
      !this.store.sqlite
        .prepare("UPDATE moderation_cases SET state='cancelled' WHERE id=? AND state='prepared'")
        .run(id).changes
    )
      throw new HttpError(409, 'Операция уже выполняется');
  }
  async change(
    id: number,
    actor: { userId: string; name: string },
    input: { reason: string; revision: number; revoke?: boolean },
  ) {
    await requireCapability(this.discord, this.store, this.config, actor.userId, 'moderationManage');
    const row = this.get(id);
    if (input.revoke && row.action !== 'warn')
      throw new HttpError(
        400,
        'Отмена записи доступна для предупреждений; санкции снимаются отдельной командой',
      );
    if (
      !this.store.sqlite
        .prepare(
          'UPDATE moderation_cases SET reason=?,revoked=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
        )
        .run(input.reason, input.revoke ? 1 : row.revoked, Date.now(), id, input.revision).changes
    )
      throw new HttpError(409, 'Дело изменено другим сотрудником');
    this.record(this.get(id), actor.userId, 'edited', {
      before: row,
      reason: input.reason,
      revoked: input.revoke || false,
    });
    return this.get(id);
  }
  async resolve(
    id: number,
    actor: { userId: string; name: string },
    state: 'applied' | 'failed',
    reason: string,
  ) {
    await requireCapability(this.discord, this.store, this.config, actor.userId, 'moderationManage');
    const row = this.get(id);
    if (row.state !== 'unknown') throw new HttpError(409, 'Результат не является неопределённым');
    this.store.sqlite
      .prepare('UPDATE moderation_cases SET state=?,error=?,revision=revision+1,updated_at=? WHERE id=?')
      .run(state, reason, Date.now(), id);
    if (state === 'applied' && ['ban', 'tempban', 'timeout', 'role-mute'].includes(row.action)) {
      const kind = row.action === 'tempban' ? 'ban' : row.action;
      this.store.sqlite
        .prepare(
          'INSERT INTO moderation_active(target,kind,case_id,expected) VALUES(?,?,?,?) ON CONFLICT(target,kind) DO UPDATE SET case_id=excluded.case_id,expected=excluded.expected',
        )
        .run(row.target, kind, row.id, row.expires_at ? new Date(row.expires_at).toISOString() : null);
      if (row.expires_at)
        this.jobs.enqueue(
          `moderation:expire:${row.id}`,
          'moderation.expire',
          row.operation_id,
          { id: row.id },
          row.expires_at,
        );
    }
    this.record(this.get(id), actor.userId, 'resolved', { state, reason });
    if (state === 'failed' && row.action === 'lock')
      this.store.sqlite
        .prepare('DELETE FROM moderation_locks WHERE channel_id=? AND case_id=?')
        .run(row.target, row.id);
    return this.get(id);
  }
  async clearWarnings(target: string, actor: { userId: string; name: string }, reason: string) {
    await requireCapability(this.discord, this.store, this.config, actor.userId, 'moderationManage');
    return this.store.sqlite
      .transaction(() => {
        const rows = this.store.sqlite
          .prepare("SELECT * FROM moderation_cases WHERE target=? AND action='warn' AND revoked=0")
          .all(target) as ModerationCase[];
        for (const row of rows) {
          this.store.sqlite
            .prepare('UPDATE moderation_cases SET revoked=1,revision=revision+1,updated_at=? WHERE id=?')
            .run(Date.now(), row.id);
          this.record(this.get(row.id), actor.userId, 'cleared', { reason });
        }
        return { count: rows.length };
      })
      .immediate();
  }
  async reviseDuration(
    id: number,
    actor: { userId: string; name: string },
    duration: number | null,
    reason: string,
  ) {
    const row = this.get(id);
    if (row.state !== 'applied' || !['ban', 'tempban', 'timeout', 'role-mute'].includes(row.action))
      throw new HttpError(409, 'У дела нет изменяемой санкции');
    const next = await this.prepare(
      {
        action: row.action === 'tempban' && !duration ? 'ban' : row.action,
        target: row.target,
        reason,
        duration,
        deleteSeconds: 0,
        operationId: crypto.randomUUID(),
      },
      actor,
      'duration:' + row.id,
    );
    this.record(row, actor.userId, 'duration.requested', { nextCase: next.id, duration });
    return next;
  }
  private finish(row: ModerationCase, state: string, error: string | null = null) {
    this.store.sqlite
      .transaction(() => {
        this.store.sqlite
          .prepare('UPDATE moderation_cases SET state=?,error=?,revision=revision+1,updated_at=? WHERE id=?')
          .run(state, error, Date.now(), row.id);
        this.record(this.get(row.id), row.actor, 'result', { state, error });
      })
      .immediate();
    this.activity.record(
      { userId: row.actor, name: row.actor === this.config.clientId ? 'Open Bot' : row.actor },
      {
        kind: 'moderation.result',
        target: String(row.id),
        summary: `Дело #${row.id}: ${row.action} — ${state}`,
        details: { caseId: row.id, state, source: row.source },
      },
    );
  }
  private async perform(row: ModerationCase) {
    const input = moderationRequestSchema.parse(JSON.parse(row.detail).input),
      rest = restPort(this.discord),
      settings = this.settings().document;
    const options = {
      reason: `Open Bot #${row.id}: ${row.reason}`.slice(0, 512),
      get signal() {
        return AbortSignal.timeout(15000);
      },
    };
    if (row.actor !== this.config.clientId)
      await requireCapability(this.discord, this.store, this.config, row.actor, 'moderationManage');
    await this.validate(row.actor, input, row.source === 'expiry');
    if (
      this.store.sqlite
        .prepare(
          "SELECT 1 FROM moderation_cases WHERE target=? AND id<>? AND state IN ('running','unknown') LIMIT 1",
        )
        .get(row.target, row.id)
    )
      throw new HttpError(409, 'Есть незавершённая операция для этой цели');
    if (row.state === 'running') {
      this.finish(
        row,
        'unknown',
        'Процесс остановился во время обращения к Discord. Сверьте результат вручную.',
      );
      return;
    }
    const detail = JSON.parse(row.detail) as {
      input: ModerationRequest;
      messageIds?: string[];
      removed?: string[];
      removedPermissions?: Record<string, string>;
      muteRole?: string;
    };
    if (row.action === 'role-mute') {
      const auth = await this.authority.load(row.actor, row.target),
        mute = auth.roles.find((role) => role.id === settings.muteRole);
      if (
        !mute ||
        mute.managed ||
        (BigInt(mute.permissions) & P.Administrator) !== 0n ||
        !auth.higher(auth.top(auth.bot), mute) ||
        (row.actor !== auth.guild.owner_id && !auth.higher(auth.top(auth.executor), mute))
      )
        throw new HttpError(403, 'Настройте доступную роль мута ниже исполнителя и бота');
      this.authority.validatePublicRoles(auth, [mute.id], [mute.id]);
      detail.muteRole = mute.id;
      detail.removed = (auth.subject?.roles || []).filter((id) => settings.removeOnMute.includes(id));
      detail.removedPermissions = {};
      for (const id of detail.removed) {
        const role = auth.roles.find((item) => item.id === id);
        if (
          !role ||
          role.managed ||
          !auth.higher(auth.top(auth.bot), role) ||
          (row.actor !== auth.guild.owner_id && !auth.higher(auth.top(auth.executor), role))
        )
          throw new HttpError(403, 'Нельзя изменять одну из снимаемых ролей');
        detail.removedPermissions[id] = role.permissions;
      }
    }
    if (row.action === 'lock') {
      const { channel } = await this.authority.channel(row.actor, row.target, P.ManageChannels);
      const overwrite = ('permission_overwrites' in channel ? channel.permission_overwrites : [])?.find(
        (item) => item.id === this.config.guildId,
      );
      const allow = BigInt(overwrite?.allow || '0'),
        deny = BigInt(overwrite?.deny || '0'),
        mask = P.SendMessages | P.SendMessagesInThreads;
      this.store.sqlite
        .prepare(
          'INSERT INTO moderation_locks(channel_id,case_id,before_allow,before_deny,applied_allow,applied_deny) VALUES(?,?,?,?,?,?)',
        )
        .run(row.target, row.id, String(allow), String(deny), String(allow & ~mask), String(deny | mask));
    }
    const until = input.duration ? Date.now() + input.duration * 1000 : null;
    this.store.sqlite
      .prepare("UPDATE moderation_cases SET state='running',detail=?,expires_at=? WHERE id=?")
      .run(JSON.stringify(detail), until, row.id);
    if (row.action === 'kick')
      await rest.delete(`/guilds/${this.config.guildId}/members/${row.target}`, options);
    else if (['ban', 'tempban', 'softban'].includes(row.action)) {
      await rest.put(`/guilds/${this.config.guildId}/bans/${row.target}`, {
        ...options,
        body: { delete_message_seconds: input.deleteSeconds },
      });
      if (row.action === 'softban')
        await rest.delete(`/guilds/${this.config.guildId}/bans/${row.target}`, options);
    } else if (row.action === 'unban')
      await rest.delete(`/guilds/${this.config.guildId}/bans/${row.target}`, options);
    else if (['timeout', 'untimeout'].includes(row.action))
      await rest.patch(`/guilds/${this.config.guildId}/members/${row.target}`, {
        ...options,
        body: {
          communication_disabled_until: row.action === 'timeout' ? new Date(until!).toISOString() : null,
        },
      });
    else if (row.action === 'role-mute') {
      for (const id of detail.removed || [])
        await rest.delete(`/guilds/${this.config.guildId}/members/${row.target}/roles/${id}`, options);
      await rest.put(
        `/guilds/${this.config.guildId}/members/${row.target}/roles/${detail.muteRole}`,
        options,
      );
    } else if (row.action === 'unmute') await this.restoreMute(row.target, row.actor, options);
    else if (row.action === 'purge') {
      const recent: string[] = [];
      for (const id of detail.messageIds || []) {
        try {
          const message = (await rest.get(`/channels/${row.target}/messages/${id}`, {
            signal: options.signal,
          })) as APIMessage;
          if (!input.purge?.includePinned && message.pinned) continue;
          if (Number((BigInt(id) >> 22n) + 1420070400000n) > Date.now() - 13.9 * 86400000) recent.push(id);
          else await rest.delete(`/channels/${row.target}/messages/${id}`, options);
        } catch (error) {
          if (!knownMissing(error, 10008)) throw error;
        }
      }
      for (let offset = 0; offset < recent.length; offset += 100) {
        const group = recent.slice(offset, offset + 100);
        if (group.length === 1) await rest.delete(`/channels/${row.target}/messages/${group[0]}`, options);
        else
          await rest.post(`/channels/${row.target}/messages/bulk-delete`, {
            ...options,
            body: { messages: group },
          });
      }
    } else if (row.action === 'lock') {
      const saved = this.store.sqlite
        .prepare('SELECT applied_allow,applied_deny FROM moderation_locks WHERE channel_id=?')
        .get(row.target) as { applied_allow: string; applied_deny: string };
      await rest.put(`/channels/${row.target}/permissions/${this.config.guildId}`, {
        ...options,
        body: { type: 0, allow: saved.applied_allow, deny: saved.applied_deny },
      });
    } else if (row.action === 'unlock') await this.unlock(row.target, row.actor, options);
    this.store.sqlite
      .transaction(() => {
        if (['ban', 'tempban', 'timeout', 'role-mute'].includes(row.action)) {
          const kind = row.action === 'tempban' ? 'ban' : row.action;
          this.store.sqlite
            .prepare(
              'INSERT INTO moderation_active(target,kind,case_id,expected) VALUES(?,?,?,?) ON CONFLICT(target,kind) DO UPDATE SET case_id=excluded.case_id,expected=excluded.expected',
            )
            .run(row.target, kind, row.id, until ? new Date(until).toISOString() : null);
          if (until)
            this.jobs.enqueue(
              `moderation:expire:${row.id}`,
              'moderation.expire',
              row.operation_id,
              { id: row.id },
              until,
            );
        }
        if (['unban', 'untimeout', 'unmute'].includes(row.action))
          this.store.sqlite
            .prepare('DELETE FROM moderation_active WHERE target=? AND kind=?')
            .run(
              row.target,
              ({ unban: 'ban', untimeout: 'timeout', unmute: 'role-mute' } as Record<string, string>)[
                row.action
              ],
            );
        this.finish(row, 'applied');
      })
      .immediate();
    if (row.action === 'warn') await this.escalate(row);
    if (settings.notifyDm && !channelActions.has(row.action) && row.action !== 'note') {
      try {
        const dm = (await rest.post('/users/@me/channels', {
          body: { recipient_id: row.target },
          signal: AbortSignal.timeout(10000),
        })) as { id: string };
        await rest.post(`/channels/${dm.id}/messages`, {
          body: {
            flags: 32768,
            components: [
              {
                type: 10,
                content: `## Дело #${row.id}\nДействие: ${row.action}\nПричина: ${row.reason}\nСрок: ${row.duration ? row.duration + ' сек.' : 'не применяется / бессрочно'}${settings.appealUrl ? '\nАпелляция: ' + settings.appealUrl : ''}`,
              },
            ],
            allowed_mentions: { parse: [] },
          },
          signal: AbortSignal.timeout(10000),
        });
      } catch (error) {
        this.onError(error, 'moderation.dm');
      }
    }
  }
  private async restoreMute(target: string, actor: string, options: { reason: string; signal: AbortSignal }) {
    const active = this.store.sqlite
      .prepare("SELECT case_id FROM moderation_active WHERE target=? AND kind='role-mute'")
      .get(target) as { case_id: number } | undefined;
    if (!active) throw new HttpError(409, 'Нет сохранённого ролевого мута');
    const detail = JSON.parse(this.get(active.case_id).detail) as {
        removed: string[];
        muteRole: string;
        removedPermissions?: Record<string, string>;
      },
      rest = restPort(this.discord);
    const auth = await this.authority.load(actor, target);
    this.authority.validatePublicRoles(auth, [detail.muteRole], [detail.muteRole]);
    for (const id of detail.removed) {
      const role = auth.roles.find((item) => item.id === id);
      if (
        !role ||
        role.managed ||
        !auth.higher(auth.top(auth.bot), role) ||
        (actor !== auth.guild.owner_id && !auth.higher(auth.top(auth.executor), role)) ||
        detail.removedPermissions?.[id] !== role.permissions
      )
        throw new HttpError(409, 'Одна из прежних ролей недоступна для восстановления');
    }
    for (const id of detail.removed)
      await rest.put(`/guilds/${this.config.guildId}/members/${target}/roles/${id}`, options);
    await rest.delete(`/guilds/${this.config.guildId}/members/${target}/roles/${detail.muteRole}`, options);
  }
  private async unlock(channelId: string, actor: string, options: { reason: string; signal: AbortSignal }) {
    const lock = this.store.sqlite
      .prepare('SELECT * FROM moderation_locks WHERE channel_id=?')
      .get(channelId) as
      { before_allow: string; before_deny: string; applied_allow: string; applied_deny: string } | undefined;
    if (!lock) throw new HttpError(409, 'Нет исходных прав для восстановления');
    const { channel } = await this.authority.channel(actor, channelId, P.ManageChannels),
      current = ('permission_overwrites' in channel ? channel.permission_overwrites : [])?.find(
        (item) => item.id === this.config.guildId,
      );
    const mask = P.SendMessages | P.SendMessagesInThreads;
    if (
      (BigInt(current?.allow || '0') & mask) !== (BigInt(lock.applied_allow) & mask) ||
      (BigInt(current?.deny || '0') & mask) !== (BigInt(lock.applied_deny) & mask)
    )
      throw new HttpError(409, 'Права отправки изменены вручную; автоматическое восстановление отменено');
    const allow = (BigInt(current?.allow || '0') & ~mask) | (BigInt(lock.before_allow) & mask),
      deny = (BigInt(current?.deny || '0') & ~mask) | (BigInt(lock.before_deny) & mask);
    await restPort(this.discord).put(`/channels/${channelId}/permissions/${this.config.guildId}`, {
      ...options,
      body: { type: 0, allow: String(allow), deny: String(deny) },
    });
    this.store.sqlite.prepare('DELETE FROM moderation_locks WHERE channel_id=?').run(channelId);
  }
  private async escalate(row: ModerationCase) {
    const count = (
      this.store.sqlite
        .prepare(
          "SELECT count(*) AS count FROM moderation_cases WHERE target=? AND action='warn' AND state='applied' AND revoked=0",
        )
        .get(row.target) as { count: number }
    ).count;
    const policy = this.settings().document.escalation.find((item) => item.warnings === count);
    if (policy)
      await this.enqueueSystem(
        {
          action: policy.action,
          target: row.target,
          reason: `Порог ${count} предупреждений (дело #${row.id})`,
          duration: policy.duration,
          deleteSeconds: 0,
        },
        `escalation:${row.id}`,
        'escalation',
      );
  }
  private async expire(job: Job) {
    const { id } = z.object({ id: z.number().int() }).parse(JSON.parse(job.payload)),
      row = this.get(id),
      kind = row.action === 'tempban' ? 'ban' : row.action;
    const active = this.store.sqlite
      .prepare('SELECT * FROM moderation_active WHERE target=? AND kind=?')
      .get(row.target, kind) as { case_id: number; expected: string | null } | undefined;
    if (!active || active.case_id !== row.id) return;
    if (kind === 'ban') {
      try {
        const ban = (await restPort(this.discord).get(`/guilds/${this.config.guildId}/bans/${row.target}`, {
          signal: AbortSignal.timeout(10000),
        })) as { reason?: string | null };
        if (!ban.reason?.startsWith(`Open Bot #${row.id}:`)) {
          this.store.sqlite
            .prepare('DELETE FROM moderation_active WHERE target=? AND kind=? AND case_id=?')
            .run(row.target, kind, row.id);
          return;
        }
      } catch (error) {
        if (knownMissing(error, 10026)) {
          this.store.sqlite
            .prepare('DELETE FROM moderation_active WHERE target=? AND kind=? AND case_id=?')
            .run(row.target, kind, row.id);
          return;
        }
        throw error;
      }
    }
    if (kind === 'timeout') {
      let member: APIGuildMember;
      try {
        member = (await restPort(this.discord).get(`/guilds/${this.config.guildId}/members/${row.target}`, {
          signal: AbortSignal.timeout(10000),
        })) as APIGuildMember;
      } catch (error) {
        if (knownMissing(error, 10007)) return;
        throw error;
      }
      if (member.communication_disabled_until && Date.parse(member.communication_disabled_until) > Date.now())
        return;
      this.store.sqlite
        .prepare('DELETE FROM moderation_active WHERE target=? AND kind=? AND case_id=?')
        .run(row.target, kind, row.id);
      return;
    }
    await this.enqueueSystem(
      {
        action: kind === 'ban' ? 'unban' : 'unmute',
        target: row.target,
        reason: `Истёк срок дела #${row.id}`,
        duration: null,
        deleteSeconds: 0,
      },
      `expiry:${row.operation_id}`,
      'expiry',
    );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.store.sqlite
        .prepare("UPDATE moderation_cases SET state='cancelled' WHERE state='prepared' AND created_at<?")
        .run(Date.now() - 90000);
      for (let n = 0; n < 10; n++) {
        const job = this.jobs.claim(['moderation.execute', 'moderation.expire']);
        if (!job) break;
        const started = Date.now();
        try {
          if (job.kind === 'moderation.expire') await this.expire(job);
          else {
            const row = this.get((JSON.parse(job.payload) as { id: number }).id);
            if (['queued', 'running'].includes(row.state)) await this.perform(row);
          }
          this.jobs.finish(job);
          telemetry.observe('moderation', job.kind, 'success', started);
        } catch (error) {
          if (job.kind === 'moderation.execute') {
            const row = this.get((JSON.parse(job.payload) as { id: number }).id),
              status = Number((error as { status?: number }).status);
            this.finish(
              row,
              row.state === 'running' &&
                (['softban', 'role-mute', 'unmute', 'purge'].includes(row.action) ||
                  !(status >= 400 && status < 500))
                ? 'unknown'
                : 'failed',
              errorText(error),
            );
          }
          this.jobs.fail(
            job,
            errorText(error),
            job.kind === 'moderation.expire'
              ? Date.now() + Math.min(3600000, 10000 * 2 ** Math.min(job.attempts, 8))
              : undefined,
          );
          this.onError(error, 'moderation.jobs');
          telemetry.observe('moderation', job.kind, 'error', started);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
