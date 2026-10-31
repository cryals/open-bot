import { randomInt, randomUUID } from 'node:crypto';
import type { APIMessageTopLevelComponent } from 'discord.js';
import { PermissionFlagsBits as P } from 'discord.js';
import type { ModuleContext } from '../../runtime/types.js';
import { CommunityStore } from '../../community-store.js';
import { GuildAuthority, publicRoleForbiddenPermissions } from '../../authority.js';
import { restPort } from '../../module-http.js';
import { sendBlocks } from '../../module-discord.js';
import { HttpError } from '../../errors.js';
import { currentMember } from '../anti-raid/service.js';
type Panel = import('zod').infer<
  typeof import('../../../shared/community.js').roleMenusSchema
>['panels'][number];
export class RoleMenuService {
  private configs: CommunityStore;
  private authority: GuildAuthority;
  constructor(private context: ModuleContext) {
    this.configs = new CommunityStore(context.store);
    this.authority = new GuildAuthority(context.config, context.discord, context.store);
  }
  panel(id: string) {
    const settings = this.configs.config('role-menus', true);
    if (!settings.document.enabled) throw new HttpError(409, 'Панели ролей выключены');
    const panel = settings.document.panels.find((panel) => panel.id === id);
    if (!panel) throw new HttpError(404, 'Панель не найдена');
    return { panel, version: settings.version };
  }
  async publish(id: string) {
    const { panel, version } = this.panel(id);
    if (panel.kind === 'reactions' && !panel.messageId)
      throw new HttpError(400, 'Укажите существующее сообщение для реакций');
    const { auth } = await this.authority.channel(
      this.context.config.clientId,
      panel.channelId,
      P.ViewChannel | P.SendMessages,
    );
    this.authority.validatePublicRoles(
      auth,
      panel.options.map((option) => option.roleId),
      panel.options.map((option) => option.roleId),
    );
    for (const option of panel.options) {
      const role = auth.roles.find((role) => role.id === option.roleId);
      if (!role || role.managed || !auth.higher(auth.top(auth.bot), role))
        throw new HttpError(403, 'Одна из ролей недоступна боту');
    }
    const saved = this.context.store.sqlite
      .prepare('SELECT message_id,channel_id FROM role_panels WHERE id=?')
      .get(id) as { message_id: string | null; channel_id: string } | undefined;
    const controls: APIMessageTopLevelComponent[] = [];
    if (panel.kind === 'select')
      controls.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `ob:role:${id}:${version}`,
            min_values: 0,
            max_values: panel.mode === 'single' ? 1 : Math.min(panel.maxSelected, panel.options.length),
            options: panel.options.map((option) => ({
              label: option.label,
              value: option.id,
              ...(option.emoji ? { emoji: { name: option.emoji } } : {}),
            })),
          },
        ],
      });
    else if (panel.kind === 'buttons')
      for (let offset = 0; offset < panel.options.length; offset += 5)
        controls.push({
          type: 1,
          components: panel.options.slice(offset, offset + 5).map((option) => ({
            type: 2,
            style: 2,
            label: option.label,
            custom_id: `ob:role:${id}:${version}:${option.id}`,
          })),
        });
    let messageId = panel.messageId;
    if (panel.kind !== 'reactions')
      messageId = await sendBlocks(
        this.context.discord,
        this.context.store,
        panel.channelId,
        panel.blocks,
        controls,
        `role:${id}:${version}`,
        saved?.channel_id === panel.channelId ? saved.message_id || undefined : undefined,
      );
    else
      for (const option of panel.options) {
        if (!option.emoji) throw new HttpError(400, 'Для реакций укажите emoji');
        await restPort(this.context.discord).put(
          `/channels/${panel.channelId}/messages/${messageId}/reactions/${encodeURIComponent(option.emoji)}/@me`,
          { signal: AbortSignal.timeout(10000) },
        );
      }
    this.context.store.sqlite
      .prepare(
        'INSERT INTO role_panels(id,channel_id,message_id,version,document) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,version=excluded.version,document=excluded.document,enabled=1',
      )
      .run(id, panel.channelId, messageId, version, JSON.stringify(panel));
    return { messageId };
  }
  async choose(id: string, version: number, user: string, selected: string[], reaction?: 'add' | 'remove') {
    const { panel, version: current } = this.panel(id);
    const saved = this.context.store.sqlite
      .prepare('SELECT enabled,version FROM role_panels WHERE id=?')
      .get(id) as { enabled: number; version: number } | undefined;
    if (version !== current || !saved?.enabled || saved.version !== version)
      throw new HttpError(409, 'Панель изменилась. Дождитесь повторной публикации.');
    const lock = `roles:${user}`,
      owner = randomUUID(),
      now = Date.now();
    if (
      !this.context.store.sqlite
        .prepare(
          'INSERT INTO runtime_locks(name,owner,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE runtime_locks.expires_at<?',
        )
        .run(lock, owner, now + 30000, now).changes
    )
      throw new HttpError(409, 'Предыдущее изменение ролей ещё выполняется');
    const heartbeat = setInterval(() => {
      this.context.store.sqlite
        .prepare('UPDATE runtime_locks SET expires_at=? WHERE name=? AND owner=?')
        .run(Date.now() + 30000, lock, owner);
    }, 10000);
    heartbeat.unref();
    try {
      const member = await currentMember(this.context, user);
      if (
        panel.requiredRoles.some((role) => !member.roles.includes(role)) ||
        panel.forbiddenRoles.some((role) => member.roles.includes(role))
      )
        throw new HttpError(403, 'Не выполнены условия панели');
      if (selected.some((id) => !panel.options.some((option) => option.id === id)))
        throw new HttpError(400, 'Неизвестный вариант');
      if (selected.length > panel.maxSelected) throw new HttpError(400, 'Выбрано слишком много вариантов');
      if (panel.mode === 'random') selected = [panel.options[randomInt(panel.options.length)].id];
      const allowlist = panel.options.map((option) => option.roleId),
        changes: { id: string; add: boolean }[] = [];
      if (panel.mode === 'single' && selected.length > 1) throw new HttpError(400, 'Разрешён один вариант');
      for (const option of panel.options) {
        const chosen = selected.includes(option.id),
          has = member.roles.includes(option.roleId);
        let next = has;
        if (reaction) {
          if (!chosen) {
            if (reaction === 'add' && panel.mode === 'single') next = false;
            else continue;
          } else
            next =
              reaction === 'add' ? panel.mode !== 'remove-only' : panel.mode === 'add-only' ? has : false;
        } else if (
          panel.kind === 'select' ||
          panel.mode === 'single' ||
          panel.mode === 'multiple' ||
          panel.mode === 'random'
        )
          next = chosen;
        else if (chosen)
          next = panel.mode === 'add-only' ? true : panel.mode === 'remove-only' ? false : !has;
        if (panel.mode === 'add-only' && !next) next = has;
        if (panel.mode === 'remove-only' && next) next = has;
        if (next !== has) changes.push({ id: option.roleId, add: next });
      }
      // Validate every role before changing the first one. Dangerous permissions are rejected by safeRole too.
      const auth = await this.authority.load(this.context.config.clientId, user);
      this.authority.validatePublicRoles(
        auth,
        changes.map((change) => change.id),
        allowlist,
      );
      for (const change of changes) {
        const role = auth.roles.find((role) => role.id === change.id);
        if (
          !role ||
          role.managed ||
          (BigInt(role.permissions) & publicRoleForbiddenPermissions) !== 0n ||
          !auth.higher(auth.top(auth.bot), role)
        )
          throw new HttpError(403, 'Роль недоступна или имеет опасные права');
      }
      for (const change of changes.sort((a, b) => Number(a.add) - Number(b.add)))
        await this.authority.safeRole(this.context.config.clientId, user, change.id, allowlist, change.add);
      this.context.activity.record(
        { userId: user, name: member.user?.username || user },
        { kind: 'roles.changed', target: id, summary: 'Изменены роли через панель', details: { changes } },
      );
    } finally {
      clearInterval(heartbeat);
      this.context.store.sqlite
        .prepare('DELETE FROM runtime_locks WHERE name=? AND owner=?')
        .run(lock, owner);
    }
  }
  async reaction(data: Record<string, unknown>, add: boolean) {
    if (data.user_id === this.context.config.clientId || typeof data.user_id !== 'string') return;
    const rows = this.context.store.sqlite
      .prepare('SELECT id,version,document FROM role_panels WHERE message_id=? AND enabled=1')
      .all(String(data.message_id)) as { id: string; version: number; document: string }[];
    const emoji = data.emoji as { name?: string; id?: string };
    for (const row of rows) {
      const panel = JSON.parse(row.document) as Panel;
      if (panel.kind !== 'reactions') continue;
      const key = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
      const option = panel.options.find(
        (option) => option.emoji === key || option.emoji === emoji.id || option.emoji === emoji.name,
      );
      if (option) await this.choose(row.id, row.version, data.user_id, [option.id], add ? 'add' : 'remove');
    }
  }
}
