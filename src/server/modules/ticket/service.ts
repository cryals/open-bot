import {
  PermissionFlagsBits,
  type APIMessage,
  type APIChannel,
  type APIGuildMember,
  type APIRole,
  type APIMessageTopLevelComponent,
} from 'discord.js';
import type { Config } from '../../config.js';
import type { Store } from '../../store.js';
import type { DiscordPort } from '../../discord.js';
import type { ActivityService } from '../../activity.js';
import { ticketConfigSchema, type TicketRow, type TicketCategory } from '../../../shared/modules.js';
import { TicketStore } from './store.js';
import { TicketArchive } from './archive.js';
import { restPort } from '../../module-http.js';
import { sendBlocks, prepareBlocks } from '../../module-discord.js';
import { permissions } from '../../access.js';
import { HttpError } from '../../errors.js';
import { telemetry } from '../../telemetry.js';
import { MediaService } from '../../media.js';
const bits = (...values: bigint[]) => values.reduce((a, b) => a | b, 0n).toString();
const view = PermissionFlagsBits.ViewChannel;
const customerAllow = bits(
  view,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
);
const missing = (error: unknown) => [10003, 10008].includes((error as { code?: number }).code || 0);
const controls = (id: number): APIMessageTopLevelComponent[] => [
  {
    type: 1,
    components: [
      { type: 2, style: 2, label: 'Взять', custom_id: `ob:ticket:claim:${id}` },
      { type: 2, style: 2, label: 'Ожидает ответа', custom_id: `ob:ticket:waiting:${id}` },
      { type: 2, style: 4, label: 'Закрыть', custom_id: `ob:ticket:close:${id}` },
      { type: 2, style: 2, label: 'Служебное обсуждение', custom_id: `ob:ticket:staff:${id}` },
    ],
  },
];
export class TicketService {
  readonly tickets: TicketStore;
  readonly archive: TicketArchive;
  private busy = false;
  private membersChecked = 0;
  private membersCursor = 0;
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly discord: DiscordPort,
    readonly activity: ActivityService,
    private onError: (error: unknown, scope: string) => void = () => {},
  ) {
    this.tickets = new TicketStore(store);
    this.archive = new TicketArchive(config, store, this.tickets);
  }
  category(id: string) {
    const category = this.tickets.config().document.categories.find((category) => category.id === id);
    if (!category) throw new HttpError(404, 'Категория тикета не найдена');
    return category;
  }
  async access(user: string) {
    return permissions(this.discord, this.store, this.config, user);
  }
  async support(ticket: TicketRow, user: string) {
    const access = await this.access(user);
    if (access.ticketManage) return true;
    const member = (await restPort(this.discord).get(`/guilds/${this.config.guildId}/members/${user}`, {
      signal: AbortSignal.timeout(10000),
    })) as APIGuildMember;
    return this.category(ticket.category_id).supportRoles.some((role) => member.roles.includes(role));
  }
  async canClose(ticket: TicketRow, user: string) {
    return ticket.author_id === user || (await this.support(ticket, user));
  }
  async validateConfig(input: unknown) {
    const settings = ticketConfigSchema.parse(input);
    if (settings.enabled && !this.config.ticketEnabled)
      throw new HttpError(400, 'Включите TICKETS_ENABLED и Message Content Intent, затем перезапустите Bot');
    if (!settings.enabled) return settings;
    if (!settings.staffChannelId) throw new HttpError(400, 'Выберите закрытый служебный канал');
    const rest = restPort(this.discord);
    const channels = (await rest.get(`/guilds/${this.config.guildId}/channels`, {
      signal: AbortSignal.timeout(10000),
    })) as APIChannel[];
    const roles = (await rest.get(`/guilds/${this.config.guildId}/roles`, {
      signal: AbortSignal.timeout(10000),
    })) as APIRole[];
    const staff = channels.find((channel) => channel.id === settings.staffChannelId);
    if (!staff || staff.type !== 0)
      throw new HttpError(400, 'Служебный канал должен быть текстовым каналом этого сервера');
    const overwrites = staff.permission_overwrites || [];
    const everyone = overwrites.find((overwrite) => overwrite.id === this.config.guildId);
    if (!everyone || (BigInt(everyone.deny) & view) === 0n)
      throw new HttpError(400, 'В служебном канале @everyone должен иметь запрет View Channel');
    for (const id of [settings.fullRoleId, settings.viewRoleId]) {
      const role = roles.find((role) => role.id === id);
      if (!role) throw new HttpError(400, 'Роль Ticket не найдена');
      if (
        (BigInt(role.permissions) &
          (PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageThreads)) !==
        0n
      )
        throw new HttpError(
          400,
          'Роли Ticket не должны иметь Administrator или Manage Threads: это раскрывает приватные ветки',
        );
      const overwrite = overwrites.find((overwrite) => overwrite.id === id);
      if (!overwrite || (BigInt(overwrite.allow) & view) === 0n)
        throw new HttpError(400, 'Обеим ролям Ticket нужен View Channel в служебном канале');
    }
    const staffRoles = new Set([settings.fullRoleId, settings.viewRoleId]);
    const botRoles = new Set(
      roles.filter((role) => role.tags?.bot_id === this.config.clientId).map((role) => role.id),
    );
    if (
      overwrites.some(
        (overwrite) =>
          (BigInt(overwrite.allow) & view) !== 0n &&
          overwrite.id !== this.config.clientId &&
          !botRoles.has(overwrite.id) &&
          !staffRoles.has(overwrite.id),
      )
    )
      throw new HttpError(400, 'В служебном канале View Channel разрешён посторонней роли/участнику');
    for (const category of settings.categories) {
      if (!channels.some((channel) => channel.id === category.parentId && channel.type === 4))
        throw new HttpError(400, 'Выберите существующую Discord-категорию для ' + category.name);
      if (!category.supportRoles.length)
        throw new HttpError(400, 'Укажите поддержку категории ' + category.name);
      if (
        category.supportRoles.includes(this.config.guildId) ||
        category.supportRoles.some((id) => !roles.some((role) => role.id === id))
      )
        throw new HttpError(400, 'Недопустимая роль поддержки');
      if (category.mentionRole && !category.supportRoles.includes(category.mentionRole))
        throw new HttpError(400, 'Уведомлять можно только выбранную роль поддержки');
    }
    const active = this.store.sqlite
      .prepare(
        "SELECT category_id FROM tickets WHERE state IN ('creating','open','claimed','waiting','closing')",
      )
      .all() as { category_id: string }[];
    if (active.some((ticket) => !settings.categories.some((category) => category.id === ticket.category_id)))
      throw new HttpError(409, 'Нельзя удалить категорию с активными тикетами');
    return settings;
  }
  async saveConfig(input: unknown, version: number, actor: { userId: string; name: string }) {
    const settings = await this.validateConfig(input),
      before = this.tickets.config();
    for (const blocks of [settings.panel, ...settings.categories.map((category) => category.intro)])
      new MediaService(this.store).validate(blocks);
    prepareBlocks(this.store, settings.panel, controls(999999999), 'validation');
    for (const category of settings.categories)
      prepareBlocks(
        this.store,
        [
          ...category.intro,
          {
            id: 'ticket-meta',
            type: 'text',
            content:
              'Тикет #999999999\nАвтор: ' +
              '0'.repeat(20) +
              '\nКатегория: ' +
              category.name +
              '\nПоддержка: ' +
              '0'.repeat(20),
          },
        ],
        controls(999999999),
        'validation',
      );
    if (!(await this.access(actor.userId)).admin) {
      const previous = JSON.stringify(before.document);
      for (const match of JSON.stringify(settings).matchAll(/\/api\/media\/([a-f0-9-]{36})/g)) {
        const file = this.store.sqlite.prepare('SELECT actor FROM media WHERE id=?').get(match[1]) as
          { actor: string } | undefined;
        if (file?.actor !== actor.userId && !previous.includes(match[0]))
          throw new HttpError(403, 'Используйте свои загрузки или ранее предоставленные файлы Ticket');
      }
    }
    const result = this.store.sqlite
      .transaction(() => {
        const active = this.store.sqlite
          .prepare(
            "SELECT category_id FROM tickets WHERE state IN ('creating','open','claimed','waiting','closing')",
          )
          .all() as { category_id: string }[];
        if (
          active.some((ticket) => !settings.categories.some((category) => category.id === ticket.category_id))
        )
          throw new HttpError(409, 'Нельзя удалить категорию с активными тикетами');
        if (
          active.length &&
          (settings.staffChannelId !== before.document.staffChannelId ||
            settings.fullRoleId !== before.document.fullRoleId)
        )
          throw new HttpError(409, 'Нельзя менять служебный канал или полную роль при активных тикетах');
        // Roles/parent changes need an explicit migration, including when intake is disabled.
        for (const old of before.document.categories) {
          const next = settings.categories.find((item) => item.id === old.id);
          if (
            next &&
            (old.parentId !== next.parentId ||
              JSON.stringify(old.supportRoles) !== JSON.stringify(next.supportRoles)) &&
            active.some((ticket) => ticket.category_id === old.id)
          )
            throw new HttpError(
              409,
              'Сначала завершите активные тикеты категории перед изменением её Discord-доступа',
            );
        }
        return this.tickets.configs.save('tickets', ticketConfigSchema, settings, version);
      })
      .immediate();
    this.activity.record(actor, {
      kind: 'tickets.settings',
      target: 'tickets',
      summary: 'Изменены настройки тикетов',
      before: before.document,
      after: settings,
    });
    return result;
  }
  reserve(author: string, categoryId: string, form: Record<string, string> = {}) {
    if (!this.config.ticketEnabled) throw new HttpError(400, 'Ticket выключен в ENV');
    const category = this.category(categoryId);
    for (const question of category.questions)
      if (question.required && !form[question.id]?.trim())
        throw new HttpError(400, 'Заполните: ' + question.label);
    const ticket = this.tickets.reserve(
      author,
      categoryId,
      Object.fromEntries(
        category.questions.map((question) => [question.id, (form[question.id] || '').slice(0, 2000)]),
      ),
    );
    return ticket;
  }
  async change(
    id: number,
    actor: { userId: string; name: string },
    action: 'claim' | 'waiting' | 'close' | 'add' | 'remove' | 'category',
    value = '',
  ) {
    const ticket = this.tickets.get(id);
    const support = await this.support(ticket, actor.userId);
    if (action === 'close') {
      if (ticket.author_id !== actor.userId && !support)
        throw new HttpError(403, 'Закрытие доступно автору и поддержке');
      if (!value.trim() || value.length > 1000) throw new HttpError(400, 'Укажите причину до 1000 символов');
      if (['closing', 'closed'].includes(ticket.state)) return ticket;
      if (this.store.sqlite.prepare('SELECT 1 FROM ticket_jobs WHERE ticket_id=?').get(id))
        throw new HttpError(409, 'Сначала завершите или отмените изменение доступа/категории');
      this.tickets.patch(id, {
        state: 'closing',
        stage: 'freeze',
        reason: value,
        closed_by: actor.userId,
        next_at: 0,
        error: null,
      });
    } else {
      if (!support) throw new HttpError(403, 'Нужны права поддержки этого тикета');
      if (!['open', 'claimed', 'waiting'].includes(ticket.state)) throw new HttpError(409, 'Тикет не открыт');
      if (action === 'claim') {
        const result = this.store.sqlite
          .prepare(
            "UPDATE tickets SET assignee=?,state='claimed' WHERE id=? AND assignee IS NULL AND state IN ('open','waiting')",
          )
          .run(actor.userId, id);
        if (!result.changes) throw new HttpError(409, 'Тикет уже назначен сотруднику');
      }
      if (action === 'waiting') this.tickets.patch(id, { state: 'waiting' });
      if (action === 'add' || action === 'remove' || action === 'category') {
        if (action === 'category') {
          this.category(value);
          if (
            this.store.sqlite
              .prepare(
                "SELECT 1 FROM tickets WHERE id!=? AND author_id=? AND category_id=? AND state IN ('creating','open','claimed','waiting','closing')",
              )
              .get(id, ticket.author_id, value) ||
            this.store.sqlite
              .prepare(
                "SELECT 1 FROM ticket_jobs j JOIN tickets t ON t.id=j.ticket_id WHERE t.author_id=? AND j.action='category' AND j.value=? AND t.id!=?",
              )
              .get(ticket.author_id, value, id)
          )
            throw new HttpError(409, 'У автора уже есть обращение в целевой категории');
        } else {
          if (!/^\d{17,20}$/.test(value) || value === ticket.author_id || value === this.config.clientId)
            throw new HttpError(400, 'Недопустимый участник');
          if (action === 'add')
            await restPort(this.discord).get(`/guilds/${this.config.guildId}/members/${value}`);
        }
        try {
          this.store.sqlite
            .transaction(() => {
              if (!['open', 'claimed', 'waiting'].includes(this.tickets.get(id).state))
                throw new HttpError(409, 'Тикет уже закрывается');
              if (
                action === 'category' &&
                this.store.sqlite
                  .prepare(
                    "SELECT 1 FROM ticket_jobs j JOIN tickets t ON t.id=j.ticket_id WHERE t.author_id=? AND j.action='category' AND j.value=? AND t.id!=?",
                  )
                  .get(ticket.author_id, value, id)
              )
                throw new HttpError(409, 'Перенос в эту категорию уже запрошен');
              this.store.sqlite
                .prepare('INSERT INTO ticket_jobs(ticket_id,actor,action,value) VALUES(?,?,?,?)')
                .run(id, actor.userId, action, value);
            })
            .immediate();
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(409, 'Предыдущее изменение тикета ещё выполняется');
        }
      }
    }
    this.tickets.event(id, actor.userId, action, value || '');
    this.activity.record(actor, {
      kind: 'ticket.' + action,
      target: 'ticket:' + id,
      summary: 'Тикет #' + id + ': ' + action,
    });
    return this.tickets.get(id);
  }
  private async move(ticket: TicketRow, category: TicketCategory) {
    if (!category.enabled) throw new HttpError(400, 'Категория выключена');
    await restPort(this.discord).patch(`/channels/${ticket.channel_id}`, {
      body: { parent_id: category.parentId, permission_overwrites: this.overwrites(ticket, category) },
    });
    this.tickets.patch(ticket.id, { category_id: category.id });
  }
  private overwrites(ticket: TicketRow, category: TicketCategory) {
    const full = this.tickets.config().document.fullRoleId;
    return [
      { id: this.config.guildId, type: 0, allow: '0', deny: view.toString() },
      {
        id: this.config.clientId,
        type: 1,
        allow: bits(
          view,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ManageChannels,
        ),
        deny: '0',
      },
      ...[...new Set([...category.supportRoles, full])].map((id) => ({
        id,
        type: 0,
        allow: customerAllow,
        deny: '0',
      })),
      ...[ticket.author_id, ...(JSON.parse(ticket.participants) as string[])].map((id) => ({
        id,
        type: 1,
        allow: customerAllow,
        deny: '0',
      })),
    ];
  }
  async join(id: number, user: string) {
    const ticket = this.tickets.get(id);
    if (ticket.author_id === user) throw new HttpError(403, 'Автор не имеет доступа к служебной ветке');
    if (!(await this.access(user)).ticketView)
      throw new HttpError(403, 'Нет доступа к служебным обсуждениям');
    if (!ticket.thread_id) throw new HttpError(409, 'Ветка ещё создаётся');
    if (['closing', 'closed', 'purging'].includes(ticket.state))
      throw new HttpError(409, 'Закрытое обсуждение доступно в веб-архиве');
    await restPort(this.discord).patch(`/channels/${ticket.thread_id}`, {
      body: { archived: false, invitable: false },
    });
    await restPort(this.discord).put(`/channels/${ticket.thread_id}/thread-members/${user}`);
    this.tickets.event(id, user, 'staff.join', 'Сотрудник вошёл в служебную ветку');
    return `https://discord.com/channels/${this.config.guildId}/${ticket.thread_id}`;
  }
  async publish(channel: string, actor: { userId: string; name: string }) {
    if (!(await this.access(actor.userId)).ticketManage) throw new HttpError(403, 'Нет прав');
    if (!this.config.ticketEnabled || !this.tickets.config().document.enabled)
      throw new HttpError(400, 'Сначала включите и настройте Ticket');
    if (!(await this.discord.info()).channels.some((item) => item.id === channel))
      throw new HttpError(400, 'Выберите текстовый канал этого сервера');
    const existing = this.tickets.panels().find((panel) => panel.channel_id === channel);
    this.activity.record(actor, {
      kind: 'ticket.panel.publish',
      target: channel,
      summary: 'Запрошена публикация панели тикетов',
    });
    if (existing) {
      this.store.sqlite
        .prepare("UPDATE ticket_panels SET document=?,state='pending',error=NULL WHERE id=?")
        .run(JSON.stringify(this.tickets.config().document.panel), existing.id);
      return existing.id;
    }
    return this.tickets.panel(channel);
  }
  async raw(event: { t?: string; d?: Record<string, unknown> }) {
    if (!event.d || !event.t) return;
    const data = event.d;
    if (!['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK'].includes(event.t))
      return;
    const channel = String(data.channel_id || '');
    const ticket = this.store.sqlite
      .prepare(
        'SELECT * FROM tickets WHERE (channel_id=? OR thread_id=?) AND (expires_at IS NULL OR expires_at>?)',
      )
      .get(channel, channel, Date.now()) as TicketRow | undefined;
    if (!ticket) return;
    const scope = ticket.channel_id === channel ? 'customer' : 'staff';
    const kind = event.t.includes('DELETE') ? 'delete' : event.t === 'MESSAGE_UPDATE' ? 'update' : 'create';
    const ids = event.t === 'MESSAGE_DELETE_BULK' ? (data.ids as string[]) : [String(data.id)];
    for (const id of ids)
      await this.archive.capture(
        ticket.id,
        scope,
        { ...data, id } as Partial<APIMessage> & { id: string },
        kind,
      );
    const author = data.author as { id?: string; bot?: boolean } | undefined;
    if (
      scope === 'customer' &&
      event.t === 'MESSAGE_CREATE' &&
      author?.id &&
      author.id !== ticket.author_id &&
      !author.bot &&
      !ticket.first_response_at &&
      (await this.support(ticket, author.id))
    ) {
      const time = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : Date.now();
      this.store.sqlite
        .transaction(() => {
          const changed = this.store.sqlite
            .prepare('UPDATE tickets SET first_response_at=? WHERE id=? AND first_response_at IS NULL')
            .run(time, ticket.id);
          if (changed.changes)
            this.store.sqlite
              .prepare(
                'UPDATE ticket_totals SET first_responses=first_responses+1,first_response_seconds=first_response_seconds+? WHERE id=1',
              )
              .run(Math.max(0, (time - ticket.created_at) / 1000));
        })
        .immediate();
    }
  }
  async reconcile(ticket: TicketRow) {
    const rest = restPort(this.discord);
    for (const [scope, channel] of [
      ['customer', ticket.channel_id],
      ['staff', ticket.thread_id],
    ] as const) {
      if (!channel) continue;
      let before: string | undefined;
      for (;;) {
        let messages: APIMessage[];
        try {
          messages = (await rest.get(`/channels/${channel}/messages`, {
            query: new URLSearchParams({ limit: '100', ...(before ? { before } : {}) }),
            signal: AbortSignal.timeout(15000),
          })) as APIMessage[];
        } catch (error) {
          if (missing(error)) {
            this.tickets.patch(ticket.id, {
              archive_gap: 'Discord-канал удалён вне приложения; недоступные сообщения не восстановлены',
            });
            break;
          }
          throw error;
        }
        for (const message of messages) await this.archive.capture(ticket.id, scope, message);
        if (messages.length < 100) break;
        before = messages.at(-1)!.id;
      }
    }
  }
  async recover() {
    this.store.sqlite.prepare("UPDATE ticket_jobs SET state='pending' WHERE state='running'").run();
    this.store.sqlite
      .prepare(
        "UPDATE tickets SET archive_gap=COALESCE(archive_gap,'Возможен пропуск событий во время отключения бота'),next_at=0 WHERE state IN ('open','claimed','waiting')",
      )
      .run();
  }
  async tick() {
    if (this.busy || !this.discord.isReady()) return;
    this.busy = true;
    try {
      this.store.sqlite
        .prepare(
          "UPDATE tickets SET state='purging',stage='thread',next_at=0 WHERE expires_at<=? AND state='closed'",
        )
        .run(Date.now());
      const jobs = this.store.sqlite
        .prepare(
          "SELECT * FROM tickets WHERE next_at<=? AND state IN ('creating','closing','purging','open','claimed','waiting') ORDER BY next_at,id LIMIT 5",
        )
        .all(Date.now()) as TicketRow[];
      for (const ticket of jobs) {
        const started = Date.now();
        try {
          await this.job(ticket);
          telemetry.observe('ticket', 'job', 'success', started);
        } catch (error) {
          this.onError(error, 'ticket.job');
          const message =
            error instanceof HttpError
              ? error.message
              : 'Ошибка Discord или архива. Операция будет продолжена.';
          this.tickets.patch(ticket.id, {
            error: message,
            attempts: ticket.attempts + 1,
            next_at: Date.now() + Math.min(300000, 5000 * 2 ** Math.min(ticket.attempts, 6)),
          });
          telemetry.observe('ticket', 'job', 'error', started);
        }
      }
      await this.changes();
      await this.archive.copyPending();
      await this.publishPending();
      if (Date.now() - this.membersChecked > 60000) {
        this.membersChecked = Date.now();
        await this.checkStaffMembers();
      }
    } finally {
      this.busy = false;
    }
  }
  private async job(ticket: TicketRow) {
    const rest = restPort(this.discord),
      settings = this.tickets.config().document;
    if (ticket.state === 'creating') {
      const category = this.category(ticket.category_id);
      if (ticket.stage === 'channel') {
        if (!settings.enabled) throw new HttpError(409, 'Ticket выключен: создание приостановлено');
        await this.validateConfig(settings);
        const channels = (await rest.get(`/guilds/${this.config.guildId}/channels`)) as (APIChannel & {
          topic?: string;
        })[];
        const marker = 'open-bot:ticket:' + ticket.id;
        const existing = channels.find((channel) => channel.type === 0 && channel.topic === marker);
        const channel =
          existing ||
          ((await rest.post(`/guilds/${this.config.guildId}/channels`, {
            body: {
              name: Array.from(
                category.channelName
                  .replaceAll('{id}', String(ticket.id))
                  .replaceAll('{user}', ticket.author_id),
              )
                .slice(0, 100)
                .join(''),
              type: 0,
              parent_id: category.parentId,
              topic: marker,
              permission_overwrites: this.overwrites(ticket, category),
            },
          })) as { id: string });
        this.tickets.patch(ticket.id, { channel_id: channel.id, stage: 'thread', next_at: 0, error: null });
        return;
      }
      if (ticket.stage === 'thread') {
        if (!settings.staffChannelId) throw new HttpError(400, 'Не настроен служебный канал');
        const active = (await rest.get(`/guilds/${this.config.guildId}/threads/active`)) as {
          threads: { id: string; name: string; parent_id: string }[];
        };
        const name = 'ticket-' + ticket.id;
        const existing = active.threads.find(
          (thread) => thread.name === name && thread.parent_id === settings.staffChannelId,
        );
        const thread =
          existing ||
          ((await rest.post(`/channels/${settings.staffChannelId}/threads`, {
            body: { name, type: 12, auto_archive_duration: 1440, invitable: false },
          })) as { id: string });
        this.tickets.patch(ticket.id, {
          thread_id: thread.id,
          staff_channel_id: settings.staffChannelId,
          stage: 'control',
          next_at: 0,
          error: null,
        });
        return;
      }
      if (ticket.stage === 'control') {
        const messageId = await sendBlocks(
          this.discord,
          this.store,
          ticket.channel_id!,
          [
            ...category.intro,
            {
              id: 'ticket-meta',
              type: 'text',
              content: `### Тикет #${ticket.id}\nАвтор: <@${ticket.author_id}>\nКатегория: ${category.name}${category.mentionRole ? '\nПоддержка: <@&' + category.mentionRole + '>' : ''}`,
            },
          ],
          controls(ticket.id),
          'ticket-' + ticket.id,
          undefined,
          category.mentionRole,
        );
        this.tickets.patch(ticket.id, {
          control_message_id: messageId,
          stage: Object.keys(JSON.parse(ticket.form)).length ? 'form-0' : 'staff-card',
          next_at: 0,
          error: null,
        });
        return;
      }
      if (ticket.stage.startsWith('form-')) {
        const index = Number(ticket.stage.slice(5));
        const entries = Object.entries(JSON.parse(ticket.form) as Record<string, string>);
        const [key, value] = entries[index];
        await sendBlocks(
          this.discord,
          this.store,
          ticket.channel_id!,
          [
            {
              id: 'answer',
              type: 'text',
              content: `**${category.questions.find((question) => question.id === key)?.label || key}**\n${value || 'Ответ не указан'}`,
            },
          ],
          [],
          'ticket-form-' + ticket.id + '-' + index,
        );
        this.tickets.patch(ticket.id, {
          stage: index + 1 < entries.length ? 'form-' + (index + 1) : 'staff-card',
          next_at: 0,
          error: null,
        });
        return;
      }
      if (ticket.stage === 'staff-card') {
        const messageId = await sendBlocks(
          this.discord,
          this.store,
          ticket.staff_channel_id!,
          [
            {
              id: 'staff-ticket',
              type: 'text',
              content: `## Тикет #${ticket.id}\nКатегория: ${category.name}\nАвтор: <@${ticket.author_id}>\nСлужебная ветка доступна сотрудникам через кнопку.`,
            },
          ],
          controls(ticket.id),
          'staff-ticket-' + ticket.id,
        );
        this.tickets.patch(ticket.id, {
          staff_message_id: messageId,
          state: 'open',
          stage: 'ready',
          next_at: Date.now() + 300000,
          error: null,
        });
        this.tickets.event(ticket.id, this.config.clientId, 'ready', 'Каналы созданы');
        return;
      }
    }
    if (['open', 'claimed', 'waiting'].includes(ticket.state)) {
      await this.reconcile(ticket);
      this.tickets.patch(ticket.id, { next_at: Date.now() + 300000, error: null });
      return;
    }
    if (ticket.state === 'closing') {
      if (ticket.stage === 'freeze') {
        const channel = (await rest.get(`/channels/${ticket.channel_id}`).catch((error) => {
          if (missing(error)) return null;
          throw error;
        })) as { permission_overwrites?: { id: string; type: number; allow: string; deny: string }[] } | null;
        if (channel)
          await rest.patch(`/channels/${ticket.channel_id}`, {
            body: {
              permission_overwrites: (channel.permission_overwrites || []).map((overwrite) => ({
                ...overwrite,
                allow: (BigInt(overwrite.allow) & ~PermissionFlagsBits.SendMessages).toString(),
                deny: (BigInt(overwrite.deny) | PermissionFlagsBits.SendMessages).toString(),
              })),
            },
          });
        if (ticket.thread_id)
          await rest
            .patch(`/channels/${ticket.thread_id}`, { body: { archived: true, locked: true } })
            .catch((error) => {
              if (!missing(error)) throw error;
            });
        this.tickets.patch(ticket.id, { stage: 'archive', next_at: 0 });
        return;
      }
      if (ticket.stage === 'archive') {
        await this.reconcile(ticket);
        const files = this.store.sqlite
          .prepare("SELECT * FROM ticket_files WHERE ticket_id=? AND state!='stored'")
          .all(ticket.id) as Parameters<TicketArchive['copy']>[0][];
        for (const file of files) await this.archive.copy(file);
        if (
          this.store.sqlite
            .prepare("SELECT 1 FROM ticket_files WHERE ticket_id=? AND state!='stored' LIMIT 1")
            .get(ticket.id)
        )
          throw new HttpError(
            409,
            'Есть несохранённые вложения. Канал не удалён; проверьте лимиты и ошибки файлов.',
          );
        this.tickets.patch(ticket.id, { stage: 'archive-thread', next_at: 0 });
        return;
      }
      if (ticket.stage === 'archive-thread') {
        if (ticket.thread_id)
          await rest
            .patch(`/channels/${ticket.thread_id}`, { body: { archived: true, locked: true } })
            .catch((error) => {
              if (!missing(error)) throw error;
            });
        this.tickets.patch(ticket.id, { stage: 'delete-channel', next_at: 0 });
        return;
      }
      if (ticket.stage === 'delete-channel') {
        if (ticket.channel_id)
          await rest.delete(`/channels/${ticket.channel_id}`).catch((error) => {
            if (!missing(error)) throw error;
          });
        const now = Date.now();
        this.store.sqlite
          .transaction(() => {
            this.tickets.patch(ticket.id, {
              state: 'closed',
              stage: 'done',
              closed_at: now,
              expires_at: now + 180 * 86400000,
              next_at: now + 180 * 86400000,
              error: null,
            });
            this.tickets.event(
              ticket.id,
              ticket.closed_by || this.config.clientId,
              'closed',
              ticket.reason || '',
            );
            this.store.sqlite
              .prepare(
                'UPDATE ticket_totals SET closed=closed+1,resolution_seconds=resolution_seconds+? WHERE id=1',
              )
              .run((now - ticket.created_at) / 1000);
          })
          .immediate();
        return;
      }
    }
    if (ticket.state === 'purging') {
      if (ticket.staff_channel_id && ticket.staff_message_id)
        await rest
          .delete(`/channels/${ticket.staff_channel_id}/messages/${ticket.staff_message_id}`)
          .catch((error) => {
            if (!missing(error)) throw error;
          });
      if (ticket.thread_id)
        await rest.delete(`/channels/${ticket.thread_id}`).catch((error) => {
          if (!missing(error)) throw error;
        });
      await this.archive.purge(ticket.id);
    }
  }
  private async publishPending() {
    for (const panel of this.tickets
      .panels()
      .filter((panel) => panel.state === 'pending')
      .slice(0, 2)) {
      try {
        let id = panel.message_id;
        try {
          id = await sendBlocks(
            this.discord,
            this.store,
            panel.channel_id,
            JSON.parse(panel.document),
            [
              {
                type: 1,
                components: [{ type: 2, style: 1, label: 'Создать тикет', custom_id: 'ob:ticket:menu' }],
              },
            ],
            panel.nonce,
            id || undefined,
          );
        } catch (error) {
          if (!missing(error)) throw error;
          id = await sendBlocks(
            this.discord,
            this.store,
            panel.channel_id,
            JSON.parse(panel.document),
            [
              {
                type: 1,
                components: [{ type: 2, style: 1, label: 'Создать тикет', custom_id: 'ob:ticket:menu' }],
              },
            ],
            panel.nonce,
          );
        }
        this.store.sqlite
          .prepare("UPDATE ticket_panels SET message_id=?,state='published',error=NULL WHERE id=?")
          .run(id, panel.id);
      } catch (error) {
        this.onError(error, 'ticket.panel');
        this.store.sqlite
          .prepare(
            "UPDATE ticket_panels SET state='error',error='Ошибка публикации: проверьте блоки, канал и права' WHERE id=?",
          )
          .run(panel.id);
      }
    }
  }
  private async checkStaffMembers() {
    const tickets = this.store.sqlite
      .prepare(
        'SELECT * FROM tickets WHERE thread_id IS NOT NULL AND id>? AND (expires_at IS NULL OR expires_at>?) ORDER BY id LIMIT 20',
      )
      .all(this.membersCursor, Date.now()) as TicketRow[];
    this.membersCursor = tickets.length === 20 ? tickets.at(-1)!.id : 0;
    for (const ticket of tickets) {
      try {
        const members = (await restPort(this.discord).get(`/channels/${ticket.thread_id}/thread-members`, {
          query: new URLSearchParams({ limit: '100' }),
        })) as { user_id: string }[];
        for (const member of members) {
          if (member.user_id === this.config.clientId) continue;
          let allowed = false;
          try {
            allowed = member.user_id !== ticket.author_id && (await this.access(member.user_id)).ticketView;
          } catch {
            continue;
          }
          if (!allowed)
            await restPort(this.discord).delete(
              `/channels/${ticket.thread_id}/thread-members/${member.user_id}`,
            );
        }
      } catch {
        /* Discord removal/temporary outage is retried during the next sweep. */
      }
    }
  }
  private async changes() {
    const jobs = this.store.sqlite
      .prepare("SELECT * FROM ticket_jobs WHERE state='pending' AND next_at<=? ORDER BY id LIMIT 5")
      .all(Date.now()) as {
      id: number;
      ticket_id: number;
      actor: string;
      action: string;
      value: string;
      attempts: number;
    }[];
    for (const job of jobs) {
      try {
        if (
          !this.store.sqlite
            .prepare("UPDATE ticket_jobs SET state='running' WHERE id=? AND state='pending'")
            .run(job.id).changes
        )
          continue;
        const ticket = this.tickets.get(job.ticket_id);
        if (!(await this.support(ticket, job.actor)))
          throw new HttpError(403, 'У инициатора больше нет прав поддержки');
        if (!['open', 'claimed', 'waiting'].includes(ticket.state))
          throw new HttpError(409, 'Тикет закрывается; изменение приостановлено');
        if (job.action === 'category') await this.move(ticket, this.category(job.value));
        else {
          const participants = JSON.parse(ticket.participants) as string[];
          if (job.action === 'add') {
            await restPort(this.discord).put(`/channels/${ticket.channel_id}/permissions/${job.value}`, {
              body: { type: 1, allow: customerAllow, deny: '0' },
            });
            if (!participants.includes(job.value)) participants.push(job.value);
          } else {
            await restPort(this.discord)
              .delete(`/channels/${ticket.channel_id}/permissions/${job.value}`)
              .catch((error) => {
                if (!missing(error)) throw error;
              });
            if (participants.includes(job.value)) participants.splice(participants.indexOf(job.value), 1);
          }
          this.tickets.patch(ticket.id, { participants: JSON.stringify(participants) });
        }
        this.tickets.event(ticket.id, job.actor, job.action + '.done', job.value);
        this.store.sqlite.prepare('DELETE FROM ticket_jobs WHERE id=?').run(job.id);
      } catch (error) {
        this.onError(error, 'ticket.change');
        this.store.sqlite
          .prepare("UPDATE ticket_jobs SET state='pending',next_at=?,attempts=attempts+1,error=? WHERE id=?")
          .run(
            Date.now() + Math.min(300000, 5000 * 2 ** Math.min(job.attempts, 6)),
            error instanceof HttpError ? error.message : 'Изменение будет повторено',
            job.id,
          );
      }
    }
  }
  async purgeExpired() {
    if (this.busy || !this.discord.isReady()) return;
    this.busy = true;
    try {
      const rows = this.store.sqlite
        .prepare(
          "SELECT * FROM tickets WHERE expires_at<=? AND next_at<=? AND state IN ('closed','purging') ORDER BY id LIMIT 10",
        )
        .all(Date.now(), Date.now()) as TicketRow[];
      for (const ticket of rows) {
        this.tickets.patch(ticket.id, { state: 'purging' });
        try {
          await this.job({ ...ticket, state: 'purging' });
        } catch (error) {
          this.onError(error, 'ticket.purge');
          this.tickets.patch(ticket.id, {
            next_at: Date.now() + 60000,
            error: 'Не удалось удалить архив; повтор через минуту',
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
