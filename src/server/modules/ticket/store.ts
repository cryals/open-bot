import { randomUUID } from 'node:crypto';
import type { Store } from '../../store.js';
import { ModuleStore } from '../../module-store.js';
import { ticketConfigSchema, initialTicketConfig, type TicketRow } from '../../../shared/modules.js';
import { HttpError } from '../../errors.js';
export class TicketStore {
  readonly configs: ModuleStore;
  constructor(readonly store: Store) {
    this.configs = new ModuleStore(store);
  }
  config() {
    return this.configs.get('tickets', ticketConfigSchema, initialTicketConfig);
  }
  get(id: number, expired = false) {
    const ticket = this.store.sqlite.prepare('SELECT * FROM tickets WHERE id=?').get(id) as
      TicketRow | undefined;
    if (!ticket || (!expired && ticket.expires_at !== null && ticket.expires_at <= Date.now()))
      throw new HttpError(404, 'Тикет не найден или срок хранения истёк');
    return ticket;
  }
  list(
    filters: {
      state?: string;
      category?: string;
      author?: string;
      assignee?: string;
      search?: string;
      before?: number;
      from?: number;
      to?: number;
    } = {},
  ) {
    const conditions = ['(expires_at IS NULL OR expires_at>?)'];
    const values: unknown[] = [Date.now()];
    for (const [field, value] of [
      ['state', filters.state],
      ['category_id', filters.category],
      ['author_id', filters.author],
      ['assignee', filters.assignee],
    ])
      if (value) {
        conditions.push(field + '=?');
        values.push(value);
      }
    if (filters.search) {
      conditions.push("(CAST(id AS TEXT) LIKE ? OR author_id LIKE ? OR COALESCE(reason,'') LIKE ?)");
      values.push(...Array(3).fill('%' + filters.search + '%'));
    }
    if (filters.before) {
      conditions.push('id<?');
      values.push(filters.before);
    }
    if (filters.from) {
      conditions.push('created_at>=?');
      values.push(filters.from);
    }
    if (filters.to) {
      conditions.push('created_at<=?');
      values.push(filters.to);
    }
    return this.store.sqlite
      .prepare('SELECT * FROM tickets WHERE ' + conditions.join(' AND ') + ' ORDER BY id DESC LIMIT 51')
      .all(...values) as TicketRow[];
  }
  event(id: number, actor: string, kind: string, detail: string) {
    this.store.sqlite
      .prepare('INSERT INTO ticket_events(ticket_id,actor,kind,detail,created_at) VALUES(?,?,?,?,?)')
      .run(id, actor, kind, detail, Date.now());
  }
  reserve(author: string, category: string, form: Record<string, string>) {
    const settings = this.config().document;
    if (!settings.enabled) throw new HttpError(400, 'Тикеты выключены');
    if (!settings.categories.some((item) => item.id === category && item.enabled))
      throw new HttpError(404, 'Категория недоступна');
    return this.store.sqlite
      .transaction(() => {
        const existing = this.store.sqlite
          .prepare(
            "SELECT * FROM tickets WHERE author_id=? AND category_id=? AND state IN ('creating','open','claimed','waiting','closing')",
          )
          .get(author, category) as TicketRow | undefined;
        if (existing) return existing;
        if (
          this.store.sqlite
            .prepare(
              "SELECT 1 FROM ticket_jobs j JOIN tickets t ON t.id=j.ticket_id WHERE t.author_id=? AND j.action='category' AND j.value=?",
            )
            .get(author, category)
        )
          throw new HttpError(409, 'Обращение уже переносится в эту категорию');
        if (
          (
            this.store.sqlite
              .prepare(
                "SELECT COUNT(*) n FROM tickets WHERE author_id=? AND state IN ('creating','open','claimed','waiting','closing')",
              )
              .get(author) as { n: number }
          ).n >= this.config().document.maxOpenPerUser
        )
          throw new HttpError(429, 'Достигнут настроенный лимит активных обращений');
        const result = this.store.sqlite
          .prepare('INSERT INTO tickets(author_id,category_id,form,created_at) VALUES(?,?,?,?)')
          .run(author, category, JSON.stringify(form), Date.now());
        const id = Number(result.lastInsertRowid);
        this.event(id, author, 'created', 'Обращение поставлено в очередь создания');
        this.store.sqlite.prepare('UPDATE ticket_totals SET created=created+1 WHERE id=1').run();
        return this.get(id);
      })
      .immediate();
  }
  patch(id: number, values: Partial<TicketRow>) {
    const allowed = [
      'state',
      'stage',
      'channel_id',
      'thread_id',
      'staff_channel_id',
      'staff_message_id',
      'control_message_id',
      'assignee',
      'participants',
      'category_id',
      'reason',
      'closed_by',
      'closed_at',
      'expires_at',
      'next_at',
      'attempts',
      'error',
      'archive_gap',
      'first_response_at',
    ];
    const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
    if (entries.length)
      this.store.sqlite
        .prepare('UPDATE tickets SET ' + entries.map(([key]) => key + '=?').join(',') + ' WHERE id=?')
        .run(...entries.map(([, value]) => value), id);
  }
  panels() {
    return this.store.sqlite.prepare('SELECT * FROM ticket_panels ORDER BY id').all() as {
      id: string;
      channel_id: string;
      message_id: string | null;
      nonce: string;
      document: string;
      state: string;
      error: string | null;
    }[];
  }
  panel(channel: string) {
    const id = randomUUID();
    this.store.sqlite
      .prepare(
        "INSERT INTO ticket_panels(id,channel_id,nonce,document) VALUES(?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET document=excluded.document,state='pending',error=NULL",
      )
      .run(id, channel, randomUUID(), JSON.stringify(this.config().document.panel));
    return this.panels().find((panel) => panel.channel_id === channel)!.id;
  }
}
