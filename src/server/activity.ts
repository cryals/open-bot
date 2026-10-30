import { diffLines } from 'diff';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import type { BotMessage } from '../shared/blocks.js';
import type { ActivityEntry, ActivityPage } from '../shared/activity.js';
import { ActivityQueue, RedisActivityStream, activityEventId, type ActivityEvent } from './activity-queue.js';

type Actor = { userId: string; name: string };
type LogInput = {
  kind: string;
  target: string;
  summary: string;
  details?: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
};
type Row = {
  id: number;
  event_id: string | null;
  created_at: number;
  actor: string;
  actor_name: string;
  kind: string;
  target: string;
  summary: string;
  details: string;
  before_text: string | null;
  after_text: string | null;
  diff: string | null;
  log_channel_id: string | null;
};
export class ActivityService {
  private timer?: ReturnType<typeof setInterval>;
  private sending = false;
  private closed = false;
  private retryAt = new Map<string, number>();
  deliveryError: string | null = null;
  fileError: string | null = null;
  private databaseError: string | null = null;
  private queue: ActivityQueue;
  readonly root: string;
  constructor(
    private store: Store,
    private discord: DiscordPort,
    private secrets: string[] = [],
    private options: {
      deliver?: boolean;
      consume?: boolean;
      redisUrl?: string;
      redisKey?: string;
      onError?: (error: unknown, scope: string) => void;
    } = {},
  ) {
    this.root =
      store.sqlite.name === ':memory:'
        ? resolve('output/testlogs')
        : resolve(dirname(store.sqlite.name), 'logs');
    const stream =
      options.redisUrl && options.consume !== false
        ? new RedisActivityStream(options.redisUrl, options.redisKey || 'open-bot:activity', (error) => {
            this.options.onError?.(error, 'activity.redis');
          })
        : undefined;
    this.queue = new ActivityQueue(
      store.sqlite.name === ':memory:'
        ? resolve('output/test-outbox', activityEventId())
        : resolve(dirname(store.sqlite.name), 'activity-outbox'),
      (events) => this.persist(events),
      { consume: options.consume !== false, stream, onError: options.onError },
    );
    if (options.deliver !== false) {
      this.timer = setInterval(() => {
        void this.flush().catch((error) => options.onError?.(error, 'activity.flush'));
      }, 3000);
      this.timer.unref();
    }
  }
  private redact(value: string) {
    let result = value;
    for (const secret of this.secrets) if (secret) result = result.split(secret).join('[REDACTED]');
    return result
      .replace(/(\/api\/webhooks\/\d+\/)[^\s"<>]+/g, '$1[REDACTED]')
      .replace(/rediss?:\/\/[^\s"<>]+/gi, '[REDACTED_REDIS_URL]');
  }
  private text(value: unknown) {
    return this.redact(
      typeof value === 'string' ? value : JSON.stringify(value, null, 2).replace(/\\n/g, '\n'),
    );
  }
  private entry(row: Row): ActivityEntry {
    return {
      id: row.id,
      eventId: row.event_id,
      createdAt: row.created_at,
      actor: row.actor,
      actorName: row.actor_name,
      kind: row.kind,
      target: row.target,
      summary: row.summary,
      details: JSON.parse(row.details),
      before: row.before_text,
      after: row.after_text,
      diff: row.diff,
    };
  }
  record(actor: Actor, input: LogInput) {
    const before = input.before === undefined ? null : this.text(input.before);
    const after = input.after === undefined ? null : this.text(input.after);
    const diff =
      before !== null && after !== null && before !== after
        ? diffLines(before, after)
            .filter((part) => part.added || part.removed)
            .map((part) =>
              part.value
                .split('\n')
                .filter((line, index, array) => index < array.length - 1 || line)
                .map((line) => (part.added ? '+' : '-') + line)
                .join('\n'),
            )
            .join('\n')
        : null;
    const now = Date.now();
    const event: ActivityEvent = {
      eventId: activityEventId(),
      createdAt: now,
      actor: actor.userId,
      actorName: this.redact(actor.name),
      kind: input.kind,
      target: this.redact(input.target),
      summary: this.redact(input.summary),
      details: JSON.parse(this.redact(JSON.stringify(input.details || {}))),
      before,
      after,
      diff,
    };
    try {
      this.queue.enqueue(event);
      this.databaseError = null;
    } catch (error) {
      this.databaseError = 'Не удалось сохранить событие в локальную очередь журнала.';
      this.options.onError?.(error, 'activity.outbox');
    }
    return event.eventId;
  }
  private persist(events: ActivityEvent[]) {
    const channel = this.store.getSettings().logChannelId;
    const insert = this.store.sqlite.prepare(
      'INSERT INTO activity_log(event_id,created_at,actor,actor_name,kind,target,summary,details,before_text,after_text,diff,log_channel_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING RETURNING *',
    );
    const rows = this.store.sqlite.transaction(() =>
      events.map((event) => {
        const row = insert.get(
          event.eventId,
          event.createdAt,
          event.actor,
          event.actorName,
          event.kind,
          event.target,
          event.summary,
          JSON.stringify(event.details),
          event.before,
          event.after,
          event.diff,
          channel,
        ) as Row | undefined;
        return (
          row ||
          (this.store.sqlite.prepare('SELECT * FROM activity_log WHERE event_id=?').get(event.eventId) as Row)
        );
      }),
    )();
    // Group writes by the event's date, including events replayed after a long outage.
    const days = new Map<string, string[]>();
    for (const row of rows) {
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(row.created_at);
      const lines = days.get(day) || [];
      lines.push(JSON.stringify(this.entry(row)));
      days.set(day, lines);
    }
    try {
      mkdirSync(this.root, { recursive: true });
      for (const [day, lines] of days)
        appendFileSync(resolve(this.root, day + '-' + process.pid + '.jsonl'), lines.join('\n') + '\n');
      this.fileError = null;
    } catch (error) {
      this.fileError = 'Не удалось записать JSONL; пакет остаётся в очереди для повтора.';
      throw error;
    }
  }
  async ingest() {
    await this.queue.flush();
  }
  get storageError() {
    return this.fileError || this.databaseError || this.queue.error;
  }
  list(search = '', before = Number.MAX_SAFE_INTEGER): ActivityPage {
    const query = '%' + search + '%';
    const rows = this.store.sqlite
      .prepare(
        'SELECT * FROM activity_log WHERE id<? AND (summary LIKE ? OR target LIKE ? OR kind LIKE ? OR actor_name LIKE ? OR actor LIKE ?) ORDER BY id DESC LIMIT 100',
      )
      .all(before, query, query, query, query, query) as Row[];
    const pending = this.store.sqlite
      .prepare('SELECT count(*) AS total FROM activity_log WHERE delivered=0 AND log_channel_id IS NOT NULL')
      .get() as { total: number };
    return {
      entries: rows.map((row) => this.entry(row)),
      pending: pending.total,
      deliveryError: this.deliveryError,
      fileError: this.storageError,
    };
  }
  *export() {
    const { last } = this.store.sqlite
      .prepare('SELECT coalesce(max(id),0) AS last FROM activity_log')
      .get() as { last: number };
    let cursor = 0;
    while (cursor < last) {
      const rows = this.store.sqlite
        .prepare('SELECT * FROM activity_log WHERE id>? AND id<=? ORDER BY id LIMIT 100')
        .all(cursor, last) as Row[];
      if (!rows.length) break;
      cursor = rows.at(-1)!.id;
      for (const row of rows) yield JSON.stringify(this.entry(row)) + '\n';
    }
  }
  async flush() {
    if (this.closed || this.sending || !this.discord.isReady()) return;
    const channels = this.store.sqlite
      .prepare(
        'SELECT log_channel_id AS channel FROM activity_log WHERE delivered=0 AND log_channel_id IS NOT NULL GROUP BY log_channel_id ORDER BY min(id)',
      )
      .all() as { channel: string }[];
    const channel = channels.find(({ channel }) => (this.retryAt.get(channel) || 0) <= Date.now())?.channel;
    if (!channel) return;
    const pending = this.store.sqlite
      .prepare('SELECT * FROM activity_log WHERE delivered=0 AND log_channel_id=? ORDER BY id LIMIT 10')
      .all(channel) as Row[];
    if (!pending.length) return;
    const group: Row[] = [];
    const texts: string[] = [];
    let size = 0;
    let characters = 0;
    for (const row of pending) {
      const body =
        `**${row.summary.replace(/`/g, '')}**\nАвтор: <@${row.actor}> (${row.actor_name})\nОбъект: ${row.target}\n-# ${row.kind} · #${row.id} · <t:${Math.floor(row.created_at / 1000)}:f>` +
        (row.diff ? '\n```diff\n' + row.diff.replace(/```/g, '``\u200b`').slice(0, 1000) + '\n```' : '');
      let snippet = body.slice(0, 2800);
      while (Buffer.byteLength(JSON.stringify(snippet), 'utf8') > 6500) snippet = snippet.slice(0, -100);
      const bytes = Buffer.byteLength(JSON.stringify(snippet), 'utf8');
      if (group.length && (size + bytes > 6500 || characters + snippet.length > 3000)) break;
      group.push(row);
      texts.push(snippet);
      size += bytes;
      characters += snippet.length;
    }
    this.sending = true;
    try {
      const message: BotMessage = {
        id: 'audit',
        blocks: [
          { id: 'audit-title', type: 'text', content: '## Журнал Open Bot' },
          ...texts.map((content, index) => ({ id: 'audit-' + index, type: 'text' as const, content })),
        ],
        silent: true,
        mentions: { users: false, roles: false, everyone: false },
      };
      await this.discord.sendMessage(
        message,
        group[0].log_channel_id!,
        'activity:' + group[0].id + '-' + group.at(-1)!.id,
      );
      if (this.closed) return;
      const update = this.store.sqlite.prepare('UPDATE activity_log SET delivered=1 WHERE id=?');
      this.store.sqlite.transaction(() => {
        for (const row of group) update.run(row.id);
      })();
      this.deliveryError = null;
      this.retryAt.delete(channel);
    } catch (error) {
      this.deliveryError =
        'Не удалось отправить журнал в Discord. Проверьте канал и права бота. События сохранены.';
      this.retryAt.set(channel, Date.now() + 30000);
      this.options.onError?.(error, 'activity.delivery');
    } finally {
      this.sending = false;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.queue.close();
  }
}
