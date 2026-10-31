import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PermissionFlagsBits as P } from 'discord.js';
import type { ModuleContext } from '../../runtime/types.js';
import { CommunityStore } from '../../community-store.js';
import { restPort } from '../../module-http.js';
import { JobStore } from '../../jobs.js';
import { HttpError } from '../../errors.js';
import { GuildAuthority } from '../../authority.js';
import { requireCapability } from '../../access.js';
type ObjectData = Record<string, unknown>;
type Manifest = {
  version: 1;
  id: string;
  guildId: string;
  createdAt: number;
  complete: boolean;
  errors: { section: string; error: string }[];
  sections: Record<string, unknown>;
  files: Record<string, { name: string; mime: string; data: string; size: number; sha256: string }>;
};
export type BackupRow = {
  id: string;
  created_at: number;
  state: string;
  filename: string | null;
  error: string | null;
  summary: string | null;
};
export type RestoreRow = {
  id: string;
  backup_id: string;
  actor: string;
  plan: string;
  state: string;
  created_at: number;
  updated_at: number;
  mapping: string;
  error: string | null;
};
const sectionNames = ['roles', 'channels', 'messages', 'members', 'settings', 'extras'] as const;
const restorePlanSchema = z.object({
  sections: z.array(z.enum(sectionNames)).min(1),
  mode: z.enum(['add', 'replace']).default('add'),
  replaceConfirmation: z.string().default(''),
});
const snowflake = (value: unknown) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const checksum = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const compress = promisify(gzip),
  decompress = promisify(gunzip);
const pick = (value: ObjectData, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
const sourceFingerprint = (value: ObjectData, role = false) =>
  checksum(
    Buffer.from(
      JSON.stringify(
        pick(
          value,
          role
            ? ['id', 'name', 'permissions', 'hoist', 'mentionable', 'color']
            : ['id', 'name', 'type', 'parent_id', 'topic', 'nsfw', 'permission_overwrites'],
        ),
      ),
    ),
  );
export class GuildBackupService {
  private configs: CommunityStore;
  readonly root: string;
  private busy = false;
  constructor(private context: ModuleContext) {
    this.configs = new CommunityStore(context.store);
    this.root = resolve(dirname(context.config.databasePath), 'guild-backups');
  }
  list() {
    return this.context.store.sqlite
      .prepare('SELECT * FROM guild_backups ORDER BY created_at DESC LIMIT 20')
      .all() as BackupRow[];
  }
  restores() {
    return this.context.store.sqlite
      .prepare('SELECT * FROM guild_restores ORDER BY created_at DESC LIMIT 30')
      .all() as RestoreRow[];
  }
  queue(actor: string) {
    const id = randomUUID();
    this.context.store.sqlite
      .transaction(() => {
        this.context.store.sqlite
          .prepare("INSERT INTO guild_backups(id,created_at,state) VALUES(?,?,'queued')")
          .run(id, Date.now());
        new JobStore(this.context.store).enqueue('backup:' + id, 'community.backup', id, { id, actor });
      })
      .immediate();
    return { id };
  }
  async artifact(id: string) {
    const row = this.context.store.sqlite.prepare('SELECT * FROM guild_backups WHERE id=?').get(id) as
      BackupRow | undefined;
    if (!row || !row.filename || row.state !== 'ready') throw new HttpError(404, 'Копия не найдена');
    return readFile(resolve(this.root, row.id + '.json.gz'));
  }
  async read(id: string) {
    const bytes = await this.artifact(id);
    return this.decode(bytes);
  }
  async decode(bytes: Buffer): Promise<Manifest> {
    const max = this.configs.config('guild-backup').document.maxArchiveMb * 1024 * 1024;
    if (bytes.length > max) throw new HttpError(400, 'Архив превышает квоту');
    let value: unknown;
    try {
      value = JSON.parse(
        (await decompress(bytes, { maxOutputLength: Math.ceil(max * 1.5) })).toString('utf8'),
      );
    } catch {
      throw new HttpError(400, 'Повреждённый или слишком большой gzip JSON');
    }
    const shape = z.object({
      version: z.literal(1),
      id: z.string().uuid(),
      guildId: z.string().regex(/^\d{17,20}$/),
      createdAt: z.number().int(),
      complete: z.boolean(),
      errors: z.array(z.object({ section: z.string(), error: z.string() })),
      sections: z.record(z.string(), z.unknown()),
      files: z.record(
        z.string().regex(/^[a-f0-9]{64}$/),
        z.object({
          name: z.string().max(200),
          mime: z
            .string()
            .max(150)
            .regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/),
          data: z.string(),
          size: z.number().int().min(0),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      ),
    });
    const manifest = shape.parse(value);
    const entity = z.object({ id: z.string().regex(/^\d{17,20}$/) }).passthrough(),
      role = entity.extend({
        permissions: z.string().regex(/^\d+$/),
        position: z.number().int(),
        name: z.string().max(100),
        managed: z.boolean().optional(),
      });
    manifest.sections.roles = z.array(role).max(250).parse(manifest.sections.roles);
    manifest.sections.channels = z
      .array(
        entity.extend({
          type: z.number().int(),
          name: z.string().max(100),
          permission_overwrites: z
            .array(
              z.object({
                id: z.string().regex(/^\d{17,20}$/),
                type: z.union([z.literal(0), z.literal(1)]),
                allow: z.string().regex(/^\d+$/),
                deny: z.string().regex(/^\d+$/),
              }),
            )
            .default([]),
        }),
      )
      .max(500)
      .parse(manifest.sections.channels);
    manifest.sections.threads = z
      .array(
        entity.extend({
          parent_id: z.string().regex(/^\d{17,20}$/),
          name: z.string().max(100),
          type: z.number().int(),
        }),
      )
      .max(5000)
      .parse(manifest.sections.threads || []);
    manifest.sections.messages = z
      .record(
        z.string().regex(/^\d{17,20}$/),
        z
          .array(
            entity.extend({
              author: z
                .object({ id: z.string().regex(/^\d{17,20}$/), username: z.string().max(100) })
                .passthrough(),
              content: z.string().max(20000).optional(),
              attachments: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
            }),
          )
          .max(20),
      )
      .parse(manifest.sections.messages || {});
    manifest.sections.members = z
      .array(
        z
          .object({
            user: z.object({ id: z.string().regex(/^\d{17,20}$/) }).passthrough(),
            roles: z.array(z.string().regex(/^\d{17,20}$/)).max(250),
          })
          .passthrough(),
      )
      .max(100000)
      .parse(manifest.sections.members || []);
    let total = 0;
    for (const [key, file] of Object.entries(manifest.files)) {
      const data = Buffer.from(file.data, 'base64');
      total += data.length;
      if (data.length !== file.size || key !== file.sha256 || checksum(data) !== key || total > max)
        throw new HttpError(400, 'Неверная контрольная сумма или размер вложения');
    }
    return manifest;
  }
  async import(bytes: Buffer) {
    const manifest = await this.decode(bytes);
    if (manifest.guildId !== this.context.config.guildId) throw new HttpError(400, 'Копия другого сервера');
    manifest.id = randomUUID();
    await this.commit(manifest);
    return { id: manifest.id };
  }
  private async commit(manifest: Manifest) {
    await mkdir(this.root, { recursive: true });
    const target = resolve(this.root, manifest.id + '.json.gz'),
      temporary = target + '.tmp';
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    const encoded = JSON.stringify(manifest);
    if (
      Buffer.byteLength(encoded) >
      this.configs.config('guild-backup').document.maxArchiveMb * 1.5 * 1024 * 1024
    )
      throw new HttpError(413, 'Метаданные и файлы превысили квоту копии');
    await writeFile(temporary, await compress(encoded), { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
    this.context.store.sqlite
      .prepare(
        "INSERT INTO guild_backups(id,created_at,state,filename,summary) VALUES(?,?,'ready',?,?) ON CONFLICT(id) DO UPDATE SET state='ready',filename=excluded.filename,summary=excluded.summary,error=NULL",
      )
      .run(
        manifest.id,
        manifest.createdAt,
        manifest.id + '.json.gz',
        JSON.stringify({
          complete: manifest.complete,
          errors: manifest.errors,
          sections: Object.keys(manifest.sections),
          files: Object.keys(manifest.files).length,
        }),
      );
    const old = this.context.store.sqlite
      .prepare(
        "SELECT id FROM guild_backups WHERE state='ready' AND id NOT IN (SELECT backup_id FROM guild_restores WHERE state IN ('prepared','queued','running','unknown','failed')) ORDER BY created_at DESC LIMIT -1 OFFSET 3",
      )
      .all() as { id: string }[];
    for (const row of old) {
      await unlink(resolve(this.root, row.id + '.json.gz')).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      this.context.store.sqlite.prepare('DELETE FROM guild_backups WHERE id=?').run(row.id);
    }
  }
  async snapshot(id: string) {
    const config = this.configs.config('guild-backup').document,
      rest = restPort(this.context.discord),
      manifest: Manifest = {
        version: 1,
        id,
        guildId: this.context.config.guildId,
        createdAt: Date.now(),
        complete: true,
        errors: [],
        sections: {},
        files: {},
      };
    let size = 0;
    this.context.store.sqlite.prepare("UPDATE guild_backups SET state='running' WHERE id=?").run(id);
    const problem = (section: string, error: string) => {
      manifest.complete = false;
      manifest.errors.push({ section, error });
    };
    const get = async (path: `/${string}`, section: string, fallback: unknown) => {
      try {
        return await rest.get(path, { signal: AbortSignal.timeout(15000) });
      } catch (error) {
        problem(section, (error as { code?: number }).code?.toString() || 'API недоступен');
        return fallback;
      }
    };
    const copy = async (url: string, name: string, mime = 'application/octet-stream') => {
      try {
        const parsed = new URL(url);
        if (
          parsed.protocol !== 'https:' ||
          !['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname)
        )
          throw new Error('Недоверенный источник');
        const response = await fetch(parsed, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        mime = (response.headers.get('content-type') || mime).split(';')[0];
        if (Number(response.headers.get('content-length')) > config.maxFileMb * 1024 * 1024)
          throw new Error('Размер файла превышает лимит');
        const reader = response.body!.getReader(),
          chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > config.maxFileMb * 1024 * 1024 || size + length > config.maxArchiveMb * 1024 * 1024)
              throw new Error('Квота файлов исчерпана');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const data = Buffer.concat(chunks),
          sha256 = checksum(data);
        if (!manifest.files[sha256]) {
          manifest.files[sha256] = {
            name: name.slice(0, 200),
            mime,
            data: data.toString('base64'),
            size: data.length,
            sha256,
          };
          size += data.length;
        }
        return sha256;
      } catch (error) {
        problem('file:' + name, error instanceof Error ? error.message : 'Ошибка файла');
        return null;
      }
    };
    const guild = (await get(
      `/guilds/${this.context.config.guildId}?with_counts=true`,
      'settings',
      {},
    )) as ObjectData;
    manifest.sections.settings = pick(guild, [
      'name',
      'description',
      'icon',
      'banner',
      'splash',
      'afk_channel_id',
      'afk_timeout',
      'system_channel_id',
      'system_channel_flags',
      'rules_channel_id',
      'public_updates_channel_id',
      'verification_level',
      'default_message_notifications',
      'explicit_content_filter',
      'preferred_locale',
      'premium_progress_bar_enabled',
      'features',
    ]);
    const assets: Record<string, string | null> = {};
    for (const key of ['icon', 'banner', 'splash'])
      if (guild[key])
        assets[key] = await copy(
          `https://cdn.discordapp.com/${key === 'icon' ? 'icons' : key === 'banner' ? 'banners' : 'splashes'}/${guild.id}/${guild[key]}.png`,
          key + '.png',
          'image/png',
        );
    manifest.sections.assets = assets;
    manifest.sections.roles = await get(`/guilds/${this.context.config.guildId}/roles`, 'roles', []);
    for (const role of manifest.sections.roles as ObjectData[])
      if (role.icon)
        role.backup_file = await copy(
          `https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png`,
          String(role.name) + '-role.png',
          'image/png',
        );
    const channels = (await get(
      `/guilds/${this.context.config.guildId}/channels`,
      'channels',
      [],
    )) as ObjectData[];
    const active = (await get(`/guilds/${this.context.config.guildId}/threads/active`, 'threads', {
      threads: [],
    })) as { threads: ObjectData[] };
    const threads = [...active.threads];
    for (const channel of channels.filter(
      (channel) =>
        [0, 5, 15, 16].includes(Number(channel.type)) &&
        !config.excludedChannels.includes(String(channel.id)),
    )) {
      for (const visibility of ['public', 'private']) {
        const archived = (await get(
          `/channels/${channel.id}/threads/archived/${visibility}?limit=100`,
          `threads:${channel.id}:${visibility}`,
          { threads: [] },
        )) as { threads: ObjectData[]; has_more?: boolean };
        threads.push(...archived.threads);
        if (archived.has_more)
          problem(
            'threads:' + channel.id,
            'Сохранены первые 100 архивных веток; остальные недоступны в этом снимке',
          );
      }
    }
    manifest.sections.channels = channels.filter(
      (channel) => !config.excludedChannels.includes(String(channel.id)),
    );
    manifest.sections.threads = [
      ...new Map(
        threads
          .filter((thread) => !config.excludedChannels.includes(String(thread.parent_id)))
          .map((thread) => [thread.id, thread]),
      ).values(),
    ];
    const threadMembers: Record<string, unknown> = {};
    for (const thread of manifest.sections.threads as ObjectData[])
      threadMembers[String(thread.id)] = await get(
        `/channels/${thread.id}/thread-members?limit=100&with_member=true`,
        'thread-members:' + thread.id,
        [],
      );
    manifest.sections.threadMembers = threadMembers;
    const messages: Record<string, ObjectData[]> = {};
    if (config.includeMessages) {
      for (const channel of [...channels, ...threads].filter(
        (channel) =>
          [0, 5, 10, 11, 12].includes(Number(channel.type)) &&
          !config.excludedChannels.includes(String(channel.id)) &&
          !config.excludedChannels.includes(String(channel.parent_id)),
      )) {
        const page = (await get(
          `/channels/${channel.id}/messages?limit=20`,
          'messages:' + channel.id,
          [],
        )) as ObjectData[];
        for (const message of page) {
          const attachments = (message.attachments as ObjectData[]) || [];
          for (const attachment of attachments)
            attachment.backup_file = await copy(
              String(attachment.url),
              String(attachment.filename),
              String(attachment.content_type || 'application/octet-stream'),
            );
        }
        messages[String(channel.id)] = page.reverse();
        if (size > config.maxArchiveMb * 1024 * 1024) break;
      }
      if (!this.context.config.gateway?.messageContent)
        problem('messages', 'Message Content Intent не включён: текст и вложения могут быть неполными');
    }
    manifest.sections.messages = messages;
    if (config.includeMembers) {
      const members: ObjectData[] = [];
      let after = '0';
      for (let pages = 0; pages < 100; pages++) {
        const page = (await get(
          `/guilds/${this.context.config.guildId}/members?limit=1000&after=${after}`,
          'members',
          [],
        )) as ObjectData[];
        members.push(...page);
        if (page.length < 1000) break;
        after = String((page.at(-1)!.user as ObjectData).id);
        if (pages === 99) problem('members', 'Состав ограничен первыми 100 000 участниками');
      }
      manifest.sections.members = members;
    }
    for (const section of [
      'emojis',
      'stickers',
      'bans',
      'auto-moderation/rules',
      'onboarding',
      'welcome-screen',
      'scheduled-events',
      'integrations',
      'webhooks',
    ]) {
      const response = await get(`/guilds/${this.context.config.guildId}/${section}`, section, []);
      manifest.sections[section] =
        section === 'webhooks' && Array.isArray(response)
          ? response.map((value) =>
              pick(value as ObjectData, [
                'id',
                'type',
                'guild_id',
                'channel_id',
                'name',
                'avatar',
                'application_id',
              ]),
            )
          : response;
    }
    for (const emoji of manifest.sections.emojis as ObjectData[])
      emoji.backup_file = await copy(
        `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`,
        String(emoji.name) + '.' + (emoji.animated ? 'gif' : 'png'),
      );
    for (const sticker of manifest.sections.stickers as ObjectData[])
      if ([1, 2, 4].includes(Number(sticker.format_type)))
        sticker.backup_file = await copy(
          `https://cdn.discordapp.com/stickers/${sticker.id}.${sticker.format_type === 4 ? 'gif' : 'png'}`,
          String(sticker.name) + '.png',
        );
    await this.commit(manifest);
    return { id };
  }
  async prepareRestore(backupId: string, actor: string, input: unknown) {
    await requireCapability(
      this.context.discord,
      this.context.store,
      this.context.config,
      actor,
      'backupManage',
    );
    const plan = restorePlanSchema.parse(input),
      manifest = await this.read(backupId);
    if (plan.sections.includes('messages') && !plan.sections.includes('channels'))
      throw new HttpError(400, 'Сообщения восстанавливаются вместе с каналами');
    if (plan.sections.includes('channels') && !plan.sections.includes('roles'))
      throw new HttpError(400, 'Каналы требуют восстановления ролей и remap прав');
    if (plan.sections.includes('members') && !plan.sections.includes('roles'))
      throw new HttpError(400, 'Назначения участников требуют восстановления ролей');
    if (plan.mode === 'replace' && plan.replaceConfirmation !== `REPLACE ${this.context.config.guildId}`)
      throw new HttpError(400, 'Для замены введите REPLACE и ID сервера');
    const liveAuthority = await new GuildAuthority(
        this.context.config,
        this.context.discord,
        this.context.store,
      ).load(actor),
      liveChannels = (await restPort(this.context.discord).get(
        `/guilds/${this.context.config.guildId}/channels`,
        { signal: AbortSignal.timeout(10000) },
      )) as ObjectData[];
    const checks: Record<string, string> = {};
    for (const value of liveChannels) checks[String(value.id)] = sourceFingerprint(value);
    for (const value of liveAuthority.roles)
      checks[value.id] = sourceFingerprint(value as unknown as ObjectData, true);
    const id = randomUUID(),
      summary = {
        ...plan,
        guildId: this.context.config.guildId,
        checks,
        create: {
          roles: plan.sections.includes('roles')
            ? (manifest.sections.roles as ObjectData[])
                .filter((role) => !role.managed && role.id !== manifest.guildId)
                .map((role) => pick(role, ['id', 'name']))
            : [],
          channels: plan.sections.includes('channels')
            ? (manifest.sections.channels as ObjectData[]).map((channel) =>
                pick(channel, ['id', 'name', 'parent_id', 'type']),
              )
            : [],
        },
        conflicts: liveChannels
          .filter((channel) =>
            (manifest.sections.channels as ObjectData[]).some((source) => source.name === channel.name),
          )
          .map((channel) => pick(channel, ['id', 'name'])),
        objects: Object.fromEntries(
          Object.entries(manifest.sections).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.length : Object.keys((value as object) || {}).length,
          ]),
        ),
        warnings: [
          'Старые ID, даты отправки, авторы и реакции не восстанавливаются.',
          'Managed-роли и интеграции требуют ручного подключения.',
          ...(plan.mode === 'replace'
            ? ['Сообщения после даты копии в удаляемых каналах будут потеряны.']
            : []),
          ...manifest.errors.map((error) => error.section + ': ' + error.error),
        ],
      };
    this.context.store.sqlite
      .prepare(
        "INSERT INTO guild_restores(id,backup_id,actor,plan,state,created_at,updated_at) VALUES(?,?,?,?,'prepared',?,?)",
      )
      .run(id, backupId, actor, JSON.stringify(summary), Date.now(), Date.now());
    return this.restore(id);
  }
  restore(id: string) {
    const row = this.context.store.sqlite.prepare('SELECT * FROM guild_restores WHERE id=?').get(id) as
      RestoreRow | undefined;
    if (!row) throw new HttpError(404, 'Восстановление не найдено');
    return row;
  }
  async confirmRestore(id: string, actor: string) {
    const row = this.restore(id);
    if (row.actor !== actor || Date.now() - row.created_at > 300000)
      throw new HttpError(409, 'Подтверждение устарело или принадлежит другому исполнителю');
    await requireCapability(
      this.context.discord,
      this.context.store,
      this.context.config,
      actor,
      'backupManage',
    );
    this.context.store.sqlite
      .transaction(() => {
        if (
          this.context.store.sqlite
            .prepare("SELECT 1 FROM guild_restores WHERE state IN ('queued','running','unknown')")
            .get()
        )
          throw new HttpError(409, 'Уже есть незавершённое восстановление');
        if (
          !this.context.store.sqlite
            .prepare("UPDATE guild_restores SET state='queued',updated_at=? WHERE id=? AND state='prepared'")
            .run(Date.now(), id).changes
        )
          throw new HttpError(409, 'План уже подтверждён');
        new JobStore(this.context.store).enqueue('restore:' + id, 'community.restore', id, { id, actor });
      })
      .immediate();
    return this.restore(id);
  }
  async resume(id: string, actor: string) {
    await requireCapability(
      this.context.discord,
      this.context.store,
      this.context.config,
      actor,
      'backupManage',
    );
    const row = this.restore(id);
    if (row.state !== 'failed' && row.state !== 'cancelled')
      throw new HttpError(409, 'Сначала разрешите неопределённые шаги');
    this.context.store.sqlite
      .prepare("UPDATE guild_restores SET state='queued',actor=?,error=NULL WHERE id=?")
      .run(actor, id);
    const jobs = new JobStore(this.context.store);
    this.context.store.sqlite
      .prepare("DELETE FROM core_jobs WHERE id=? AND state IN ('failed','done','cancelled')")
      .run('restore:' + id);
    jobs.enqueue('restore:' + id, 'community.restore', id, { id, actor });
  }
  cancel(id: string) {
    this.context.store.sqlite
      .prepare(
        "UPDATE guild_restores SET state='cancelled' WHERE id=? AND state IN ('prepared','queued','failed','running')",
      )
      .run(id);
  }
  async executeRestore(id: string) {
    const row = this.restore(id),
      plan = restorePlanSchema.parse(JSON.parse(row.plan)),
      manifest = await this.read(row.backup_id),
      rest = restPort(this.context.discord),
      authority = new GuildAuthority(this.context.config, this.context.discord, this.context.store);
    await requireCapability(
      this.context.discord,
      this.context.store,
      this.context.config,
      row.actor,
      'backupManage',
    );
    const auth = await authority.load(row.actor);
    for (const permission of [P.ManageGuild, P.ManageRoles, P.ManageChannels])
      if (!auth.has(auth.executor, permission) || !auth.has(auth.bot, permission))
        throw new HttpError(403, 'Недостаточно прав Discord для восстановления');
    this.context.store.sqlite
      .prepare("UPDATE guild_restores SET state='running',updated_at=? WHERE id=? AND state='queued'")
      .run(Date.now(), id);
    const mapping = JSON.parse(row.mapping) as Record<string, string>;
    mapping[manifest.guildId] = this.context.config.guildId;
    if (!plan.sections.includes('channels')) {
      const current = (await rest.get(`/guilds/${this.context.config.guildId}/channels`, {
        signal: AbortSignal.timeout(10000),
      })) as { id: string }[];
      for (const channel of current) mapping[channel.id] = channel.id;
    }
    if (!plan.sections.includes('roles')) for (const role of auth.roles) mapping[role.id] = role.id;
    for (const role of manifest.sections.roles as ObjectData[])
      if (role.managed && auth.roles.some((current) => current.id === role.id))
        mapping[String(role.id)] = String(role.id);
    const saveMap = (source: string, target: string) => {
      mapping[source] = target;
      this.context.store.sqlite
        .prepare('UPDATE guild_restores SET mapping=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(mapping), Date.now(), id);
    };
    const step = async (kind: string, source: string, perform: () => Promise<string | void>) => {
      if (this.restore(id).state === 'cancelled') throw new HttpError(409, 'Восстановление отменено');
      await requireCapability(
        this.context.discord,
        this.context.store,
        this.context.config,
        row.actor,
        'backupManage',
      );
      const saved = this.context.store.sqlite
        .prepare('SELECT state,new_id FROM guild_restore_steps WHERE restore_id=? AND kind=? AND source_id=?')
        .get(id, kind, source) as { state: string; new_id: string | null } | undefined;
      if (saved?.state === 'done') {
        if (saved.new_id) saveMap(source, saved.new_id);
        return;
      }
      if (saved?.state === 'running' || saved?.state === 'unknown') {
        this.context.store.sqlite
          .prepare("UPDATE guild_restores SET state='unknown',error=? WHERE id=?")
          .run(`Сверьте шаг ${kind}:${source} и укажите созданный ID`, id);
        throw new HttpError(409, 'Неопределённый результат создания объекта');
      }
      const stepPermission =
        kind === 'ban'
          ? P.BanMembers
          : ['emoji', 'sticker'].includes(kind)
            ? P.ManageGuildExpressions
            : kind === 'scheduled-event'
              ? P.ManageEvents
              : ['role', 'role-properties', 'role-order', 'member-role', 'replace-role'].includes(kind)
                ? P.ManageRoles
                : [
                      'channel',
                      'channel-properties',
                      'replace-channel',
                      'thread',
                      'thread-properties',
                      'thread-member',
                    ].includes(kind)
                  ? P.ManageChannels
                  : kind === 'message'
                    ? P.SendMessages
                    : P.ManageGuild;
      const stepAuth = await authority.load(row.actor);
      if (!stepAuth.has(stepAuth.executor, stepPermission) || !stepAuth.has(stepAuth.bot, stepPermission))
        throw new HttpError(403, 'Недостаточно Discord-прав для шага ' + kind);
      this.context.store.sqlite
        .prepare(
          "INSERT INTO guild_restore_steps(restore_id,source_id,kind,state) VALUES(?,?,?,'running') ON CONFLICT(restore_id,kind,source_id) DO UPDATE SET state='running',error=NULL",
        )
        .run(id, source, kind);
      try {
        const result = await perform();
        this.context.store.sqlite
          .prepare(
            "UPDATE guild_restore_steps SET state='done',new_id=? WHERE restore_id=? AND kind=? AND source_id=?",
          )
          .run(result || null, id, kind, source);
        if (result) saveMap(source, result);
      } catch (error) {
        const status = error instanceof HttpError ? error.statusCode : (error as { status?: number }).status;
        this.context.store.sqlite
          .prepare(
            'UPDATE guild_restore_steps SET state=?,error=? WHERE restore_id=? AND kind=? AND source_id=?',
          )
          .run(
            status && status >= 400 && status < 500 ? 'failed' : 'unknown',
            error instanceof Error ? error.message : 'Error',
            id,
            kind,
            source,
          );
        throw error;
      }
    };
    const options = {
        reason: 'Open Bot restore ' + id,
        get signal() {
          return AbortSignal.timeout(15000);
        },
      },
      roles = manifest.sections.roles as ObjectData[],
      channels = manifest.sections.channels as ObjectData[],
      threads = manifest.sections.threads as ObjectData[];
    if (plan.sections.includes('roles'))
      for (const role of [...roles].sort((a, b) => Number(a.position) - Number(b.position))) {
        if (role.id === manifest.guildId || role.managed) continue;
        await step('role', String(role.id), async () => {
          const body = {
            ...pick(role, ['name', 'color', 'colors', 'hoist', 'mentionable']),
            permissions: '0',
          };
          const created = (await rest.post(`/guilds/${this.context.config.guildId}/roles`, {
            ...options,
            body,
          })) as { id: string };
          return created.id;
        });
      }
    if (plan.sections.includes('channels'))
      for (const channel of [...channels].sort(
        (a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || Number(a.position) - Number(b.position),
      )) {
        if (![0, 2, 4, 5, 13, 15, 16].includes(Number(channel.type))) continue;
        await step('channel', String(channel.id), async () => {
          const created = (await rest.post(`/guilds/${this.context.config.guildId}/channels`, {
            ...options,
            body: {
              ...pick(channel, [
                'name',
                'type',
                'topic',
                'nsfw',
                'rate_limit_per_user',
                'bitrate',
                'user_limit',
                'rtc_region',
                'video_quality_mode',
                'default_auto_archive_duration',
                'default_thread_rate_limit_per_user',
                'default_sort_order',
                'default_forum_layout',
              ]),
              ...(Array.isArray(channel.available_tags)
                ? {
                    available_tags: (channel.available_tags as ObjectData[]).map((tag) =>
                      pick(tag, ['name', 'moderated', 'emoji_id', 'emoji_name']),
                    ),
                  }
                : {}),
              parent_id: mapping[String(channel.parent_id)] || null,
              permission_overwrites: [
                { id: this.context.config.guildId, type: 0, allow: '0', deny: String(P.ViewChannel) },
                {
                  id: this.context.config.clientId,
                  type: 1,
                  allow: String(P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.ManageThreads),
                  deny: '0',
                },
              ],
            },
          })) as { id: string; available_tags?: { id: string; name: string }[] };
          for (const tag of (channel.available_tags as ObjectData[]) || []) {
            const next = created.available_tags?.find((item) => item.name === tag.name);
            if (next) saveMap(String(tag.id), next.id);
          }
          return created.id;
        });
      }
    if (plan.sections.includes('channels'))
      for (const thread of threads) {
        if (!mapping[String(thread.parent_id)]) continue;
        await step('thread', String(thread.id), async () => {
          const parent = channels.find((channel) => channel.id === thread.parent_id);
          const body = {
            name: thread.name,
            auto_archive_duration: 1440,
            ...(Array.isArray(thread.applied_tags)
              ? { applied_tags: (thread.applied_tags as string[]).map((tag) => mapping[tag]).filter(Boolean) }
              : {}),
            ...([15, 16].includes(Number(parent?.type))
              ? { message: { content: 'Восстановленная ветка · Open Bot', allowed_mentions: { parse: [] } } }
              : { type: thread.type === 12 ? 12 : 11, invitable: false }),
          };
          const created = (await rest.post(`/channels/${mapping[String(thread.parent_id)]}/threads`, {
            ...options,
            body,
          })) as { id: string };
          return created.id;
        });
      }
    if (plan.sections.includes('messages'))
      for (const [channelId, messages] of Object.entries(
        (manifest.sections.messages as Record<string, ObjectData[]>) || {},
      )) {
        const destination = mapping[channelId];
        if (!destination) continue;
        for (const message of messages) {
          const author = message.author as { id: string; username: string },
            suffix = `\n-# Автор: <@${author.id}> (${author.username.replace(/[\r\n]/g, ' ').slice(0, 100)})`,
            reference = (message.message_reference as { message_id?: string })?.message_id;
          const componentText = (components: unknown[]): string =>
            components
              .map((value) => {
                const item = value as { content?: unknown; components?: unknown[] };
                return (
                  (typeof item.content === 'string' ? item.content : '') +
                  (item.components ? '\n' + componentText(item.components) : '')
                );
              })
              .filter(Boolean)
              .join('\n');
          const embedText = ((message.embeds as ObjectData[]) || [])
            .map((embed) =>
              [
                embed.title,
                embed.description,
                ...((embed.fields as ObjectData[]) || []).map(
                  (field) => String(field.name) + ': ' + String(field.value),
                ),
                embed.url,
              ]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n');
          const text =
            [String(message.content || ''), embedText, componentText((message.components as unknown[]) || [])]
              .filter(Boolean)
              .join('\n')
              .replace(
                /https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/g,
                (url, channel: string, id: string) =>
                  mapping[channel] && mapping[id]
                    ? `https://discord.com/channels/${this.context.config.guildId}/${mapping[channel]}/${mapping[id]}`
                    : url + ' (исходная ссылка; объект не сопоставлен)',
              ) +
            (reference
              ? '\n↪ ' +
                (mapping[reference]
                  ? 'https://discord.com/channels/' +
                    this.context.config.guildId +
                    '/' +
                    destination +
                    '/' +
                    mapping[reference]
                  : 'Исходный ответ недоступен')
              : '');
          const parts = text.match(/[\s\S]{1,2300}/g) || ['[Нет текстового содержимого]'];
          for (let index = 0; index < parts.length; index++)
            await step('message', String(message.id) + ':' + index, async () => {
              const attachments = ((message.attachments as ObjectData[]) || [])
                .map((file) => manifest.files[String(file.backup_file)])
                .filter(Boolean);
              const payload = {
                flags: 32768,
                components: [
                  { type: 10, content: parts[index] + suffix },
                  ...(index === 0
                    ? attachments.slice(0, 10).map((file) => ({
                        type: 13,
                        file: { url: 'attachment://' + file.name },
                        spoiler: file.name.startsWith('SPOILER_'),
                      }))
                    : []),
                ],
                allowed_mentions: { parse: [] },
                nonce: createHash('sha256')
                  .update(id + ':' + message.id + ':' + index)
                  .digest('hex')
                  .slice(0, 24),
                enforce_nonce: true,
                attachments:
                  index === 0
                    ? attachments.slice(0, 10).map((file, idx) => ({ id: idx, filename: file.name }))
                    : [],
              };
              const result = (await rest.post(`/channels/${destination}/messages`, {
                ...options,
                body: payload,
                files:
                  index === 0
                    ? attachments
                        .slice(0, 10)
                        .map((file) => ({ name: file.name, data: Buffer.from(file.data, 'base64') }))
                    : [],
              })) as { id: string };
              if (index === 0) {
                saveMap(String(message.id), result.id);
                if (message.pinned) await rest.put(`/channels/${destination}/pins/${result.id}`, options);
              }
              return result.id;
            });
        }
      }
    if (plan.sections.includes('roles'))
      for (const role of roles) {
        if (!mapping[String(role.id)] || role.id === manifest.guildId || role.managed) continue;
        await step('role-properties', String(role.id), async () => {
          const live = await authority.load(row.actor);
          if (!live.has(live.executor, BigInt(String(role.permissions))))
            throw new HttpError(403, 'Роль из копии содержит права, которых нет у исполнителя');
          await rest.patch(`/guilds/${this.context.config.guildId}/roles/${mapping[String(role.id)]}`, {
            ...options,
            body: {
              permissions: String(role.permissions),
              ...(role.backup_file && manifest.files[String(role.backup_file)]
                ? {
                    icon: `data:${manifest.files[String(role.backup_file)].mime};base64,${manifest.files[String(role.backup_file)].data}`,
                  }
                : {}),
            },
          });
        });
      }
    if (plan.sections.includes('roles'))
      await step('role-order', 'all', async () => {
        await rest.patch(`/guilds/${this.context.config.guildId}/roles`, {
          ...options,
          body: roles
            .filter((role) => !role.managed && role.id !== manifest.guildId && mapping[String(role.id)])
            .map((role) => ({ id: mapping[String(role.id)], position: role.position })),
        });
      });
    if (plan.sections.includes('members'))
      for (const member of (manifest.sections.members as ObjectData[]) || []) {
        const user = (member.user as { id: string })?.id;
        if (!snowflake(user)) continue;
        for (const role of (member.roles as string[]) || []) {
          if (!mapping[role] || role === manifest.guildId) continue;
          await step('member-role', user + ':' + role, async () => {
            await rest.put(
              `/guilds/${this.context.config.guildId}/members/${user}/roles/${mapping[role]}`,
              options,
            );
          });
        }
      }
    if (plan.sections.includes('channels'))
      for (const channel of channels) {
        if (!mapping[String(channel.id)]) continue;
        await step('channel-properties', String(channel.id), async () => {
          const live = await authority.load(row.actor);
          const overwrites = ((channel.permission_overwrites as ObjectData[]) || []).map((entry) => {
            if (!live.has(live.executor, BigInt(String(entry.allow || '0'))))
              throw new HttpError(403, 'Права канала из копии превышают права исполнителя');
            if (entry.type === 0 && !mapping[String(entry.id)])
              throw new HttpError(409, 'Не восстановлена роль из прав канала; канал остаётся закрытым');
            return { ...entry, id: entry.type === 0 ? mapping[String(entry.id)] : entry.id };
          });
          await rest.patch(`/channels/${mapping[String(channel.id)]}`, {
            ...options,
            body: { permission_overwrites: overwrites, position: channel.position },
          });
        });
      }
    if (plan.sections.includes('channels'))
      for (const thread of threads) {
        if (!mapping[String(thread.id)]) continue;
        for (const member of ((manifest.sections.threadMembers as Record<string, ObjectData[]>) || {})[
          String(thread.id)
        ] || []) {
          if (!snowflake(member.user_id)) continue;
          await step('thread-member', String(thread.id) + ':' + member.user_id, async () => {
            await rest.put(
              `/channels/${mapping[String(thread.id)]}/thread-members/${member.user_id}`,
              options,
            );
          });
        }
        await step('thread-properties', String(thread.id), async () => {
          const metadata = (thread.thread_metadata as ObjectData) || {};
          await rest.patch(`/channels/${mapping[String(thread.id)]}`, {
            ...options,
            body: {
              archived: !!metadata.archived,
              locked: !!metadata.locked,
              rate_limit_per_user: thread.rate_limit_per_user || 0,
            },
          });
        });
      }
    if (plan.sections.includes('settings'))
      await step('settings', 'guild', async () => {
        const settings = manifest.sections.settings as ObjectData,
          body = pick(settings, [
            'name',
            'description',
            'afk_timeout',
            'system_channel_flags',
            'verification_level',
            'default_message_notifications',
            'explicit_content_filter',
            'preferred_locale',
            'premium_progress_bar_enabled',
          ]);
        for (const field of [
          'afk_channel_id',
          'system_channel_id',
          'rules_channel_id',
          'public_updates_channel_id',
        ])
          if (settings[field]) body[field] = mapping[String(settings[field])] || null;
        for (const [kind, sha] of Object.entries(
          (manifest.sections.assets as Record<string, string | null>) || {},
        ))
          if (sha && manifest.files[sha])
            body[kind] = 'data:' + manifest.files[sha].mime + ';base64,' + manifest.files[sha].data;
        await rest.patch(`/guilds/${this.context.config.guildId}`, { ...options, body });
      });
    if (plan.sections.includes('extras')) {
      for (const ban of (manifest.sections.bans as ObjectData[]) || []) {
        const user = (ban.user as { id: string })?.id;
        if (user)
          await step('ban', user, async () => {
            await rest.put(`/guilds/${this.context.config.guildId}/bans/${user}`, {
              ...options,
              body: { delete_message_seconds: 0 },
            });
          });
      }
      for (const emoji of (manifest.sections.emojis as ObjectData[]) || []) {
        const file = manifest.files[String(emoji.backup_file)];
        if (file)
          await step('emoji', String(emoji.id), async () => {
            const created = (await rest.post(`/guilds/${this.context.config.guildId}/emojis`, {
              ...options,
              body: {
                name: emoji.name,
                image: `data:${file.mime};base64,${file.data}`,
                roles: ((emoji.roles as string[]) || []).map((role) => mapping[role]).filter(Boolean),
              },
            })) as { id: string };
            return created.id;
          });
      }
      for (const sticker of (manifest.sections.stickers as ObjectData[]) || []) {
        const file = manifest.files[String(sticker.backup_file)];
        if (!file) continue;
        await step('sticker', String(sticker.id), async () => {
          const created = (await rest.post(`/guilds/${this.context.config.guildId}/stickers`, {
            ...options,
            body: { name: sticker.name, description: sticker.description || '', tags: sticker.tags || '🙂' },
            files: [{ key: 'file', name: file.name, data: Buffer.from(file.data, 'base64') }],
          })) as { id: string };
          return created.id;
        });
      }
      for (const rule of (manifest.sections['auto-moderation/rules'] as ObjectData[]) || [])
        await step('native-automod', String(rule.id), async () => {
          const body = pick(rule, [
            'name',
            'event_type',
            'trigger_type',
            'trigger_metadata',
            'actions',
            'enabled',
          ]);
          body.exempt_roles = ((rule.exempt_roles as string[]) || []).map((role) => mapping[role] || role);
          body.exempt_channels = ((rule.exempt_channels as string[]) || []).map(
            (channel) => mapping[channel] || channel,
          );
          body.actions = ((rule.actions as ObjectData[]) || []).map((action) => {
            const metadata = action.metadata as ObjectData | undefined;
            return metadata?.channel_id
              ? {
                  ...action,
                  metadata: {
                    ...metadata,
                    channel_id: mapping[String(metadata.channel_id)] || metadata.channel_id,
                  },
                }
              : action;
          });
          const created = (await rest.post(`/guilds/${this.context.config.guildId}/auto-moderation/rules`, {
            ...options,
            body,
          })) as { id: string };
          return created.id;
        });
      const welcome = manifest.sections['welcome-screen'] as ObjectData | undefined;
      if (welcome?.welcome_channels)
        await step('welcome-screen', 'guild', async () => {
          await rest.patch(`/guilds/${this.context.config.guildId}/welcome-screen`, {
            ...options,
            body: {
              ...pick(welcome, ['description', 'enabled']),
              welcome_channels: (welcome.welcome_channels as ObjectData[]).map((channel) => ({
                ...channel,
                channel_id: mapping[String(channel.channel_id)] || channel.channel_id,
              })),
            },
          });
        });
      const onboarding = manifest.sections.onboarding as ObjectData | undefined;
      if (onboarding?.prompts)
        await step('onboarding', 'guild', async () => {
          const remap = (value: unknown, key = ''): unknown =>
            Array.isArray(value)
              ? value.map((item) =>
                  typeof item === 'string' && ['role_ids', 'channel_ids', 'default_channel_ids'].includes(key)
                    ? mapping[item] || item
                    : remap(item),
                )
              : value && typeof value === 'object'
                ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, key)]))
                : value;
          await rest.put(`/guilds/${this.context.config.guildId}/onboarding`, {
            ...options,
            body: remap(pick(onboarding, ['prompts', 'default_channel_ids', 'enabled', 'mode'])),
          });
        });
      for (const event of (manifest.sections['scheduled-events'] as ObjectData[]) || []) {
        if (Date.parse(String(event.scheduled_start_time)) <= Date.now()) continue;
        await step('scheduled-event', String(event.id), async () => {
          const body = {
            ...pick(event, [
              'name',
              'privacy_level',
              'entity_type',
              'entity_metadata',
              'scheduled_start_time',
              'scheduled_end_time',
              'description',
            ]),
            channel_id: event.channel_id ? mapping[String(event.channel_id)] || event.channel_id : null,
          };
          const created = (await rest.post(`/guilds/${this.context.config.guildId}/scheduled-events`, {
            ...options,
            body,
          })) as { id: string };
          return created.id;
        });
      }
    }
    if (plan.mode === 'replace') {
      // Replacement is explicit and only removes source objects after the new copy is complete.
      for (const channel of plan.sections.includes('channels') ? channels : [])
        if (snowflake(channel.id) && channel.id !== mapping[String(channel.id)])
          await step('replace-channel', String(channel.id), async () => {
            await requireCapability(
              this.context.discord,
              this.context.store,
              this.context.config,
              row.actor,
              'backupManage',
            );
            const actual = await authority.channel(row.actor, String(channel.id), P.ManageChannels),
              expected = (JSON.parse(row.plan) as { checks?: Record<string, string> }).checks?.[
                String(channel.id)
              ];
            if (!expected || sourceFingerprint(actual.channel as unknown as ObjectData) !== expected)
              throw new HttpError(409, 'Исходный канал изменён после подготовки плана; удаление остановлено');
            await rest.delete(`/channels/${channel.id}`, options);
          });
      for (const role of plan.sections.includes('roles') ? roles : [])
        if (
          snowflake(role.id) &&
          role.id !== manifest.guildId &&
          !role.managed &&
          role.id !== mapping[String(role.id)]
        )
          await step('replace-role', String(role.id), async () => {
            await requireCapability(
              this.context.discord,
              this.context.store,
              this.context.config,
              row.actor,
              'backupManage',
            );
            const current = await authority.load(row.actor),
              actual = current.roles.find((item) => item.id === role.id);
            if (!actual) return;
            if (
              !current.has(current.executor, P.ManageRoles) ||
              !current.has(current.bot, P.ManageRoles) ||
              !current.higher(current.top(current.bot), actual) ||
              (row.actor !== current.guild.owner_id && !current.higher(current.top(current.executor), actual))
            )
              throw new HttpError(403, 'Исходная роль недоступна исполнителю');
            const expected = (JSON.parse(row.plan) as { checks?: Record<string, string> }).checks?.[
              String(role.id)
            ];
            if (!expected || sourceFingerprint(actual as unknown as ObjectData, true) !== expected)
              throw new HttpError(409, 'Роль изменена после подготовки плана; удаление остановлено');
            await rest.delete(`/guilds/${this.context.config.guildId}/roles/${role.id}`, options);
          });
    }
    this.context.store.sqlite
      .prepare("UPDATE guild_restores SET state='done',updated_at=? WHERE id=?")
      .run(Date.now(), id);
    this.context.activity.record(
      { userId: row.actor, name: row.actor },
      {
        kind: 'guild.restore',
        target: id,
        summary: 'Завершено восстановление Discord-сервера',
        details: { backupId: row.backup_id, mode: plan.mode },
      },
    );
  }
  async resolveStep(id: string, kind: string, source: string, newId: string | null, actor: string) {
    await requireCapability(
      this.context.discord,
      this.context.store,
      this.context.config,
      actor,
      'backupManage',
    );
    if (newId) {
      if (!snowflake(newId)) throw new HttpError(400, 'Неверный ID');
      if (
        ![
          'channel',
          'thread',
          'role',
          'message',
          'emoji',
          'sticker',
          'native-automod',
          'scheduled-event',
        ].includes(kind)
      )
        throw new HttpError(400, 'У этого шага нет создаваемого ID');
      if (kind === 'channel' || kind === 'thread') {
        const channel = (await restPort(this.context.discord).get(`/channels/${newId}`, {
          signal: AbortSignal.timeout(10000),
        })) as { guild_id: string };
        if (channel.guild_id !== this.context.config.guildId)
          throw new HttpError(403, 'Объект другого сервера');
      } else if (
        kind === 'role' &&
        !(await this.context.discord.info()).roles.some((role) => role.id === newId)
      )
        throw new HttpError(400, 'Роль не найдена');
    }
    this.context.store.sqlite
      .prepare(
        "UPDATE guild_restore_steps SET state=?,new_id=?,error=NULL WHERE restore_id=? AND kind=? AND source_id=? AND state IN ('running','unknown')",
      )
      .run(newId ? 'done' : 'failed', newId, id, kind, source);
    this.context.store.sqlite
      .prepare("UPDATE guild_restores SET state='failed' WHERE id=? AND state='unknown'")
      .run(id);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const config = this.configs.config('guild-backup').document;
      if (!config.enabled) return;
      const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: config.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(new Date()),
        value = (type: string) => parts.find((part) => part.type === type)?.value || '',
        day = [value('year'), value('month'), value('day')].join('-'),
        clock = value('hour') + ':' + value('minute');
      if (clock >= config.time && !this.configs.state('guild-backup', 'day:' + day)) {
        this.queue(this.context.config.clientId);
        this.configs.set('guild-backup', 'day:' + day, true);
      }
    } finally {
      this.busy = false;
    }
  }
}
