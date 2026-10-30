import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const eventSchema = z.object({
  eventId: z.uuid(),
  createdAt: z.number().int(),
  actor: z.string(),
  actorName: z.string(),
  kind: z.string(),
  target: z.string(),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()),
  before: z.string().nullable(),
  after: z.string().nullable(),
  diff: z.string().nullable(),
});
export type ActivityEvent = z.infer<typeof eventSchema>;
type StreamMessage = { id: string; message: Record<string, string> };
export interface ActivityStream {
  ready(): boolean;
  append(events: ActivityEvent[]): Promise<void>;
  read(): Promise<StreamMessage[]>;
  acknowledge(ids: string[]): Promise<void>;
  close(): void;
}

/** One Bot consumer per database; its stable name recovers its own PEL after restart. */
export class RedisActivityStream implements ActivityStream {
  private client;
  private groupReady = false;
  constructor(
    url: string,
    private key: string,
    onError: (error: unknown) => void,
  ) {
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 256,
      commandOptions: { timeout: 1500 },
      socket: { connectTimeout: 1500, reconnectStrategy: (retries) => Math.min(1000 * (retries + 1), 10000) },
    });
    let failed = false;
    this.client.on('error', (error) => {
      if (!failed) onError(error);
      failed = true;
    });
    this.client.on('ready', () => {
      this.groupReady = false;
      failed = false;
    });
    void this.client.connect().catch(onError);
  }
  ready() {
    return this.client.isReady;
  }
  async append(events: ActivityEvent[]) {
    const batch = this.client.multi();
    for (const event of events) batch.xAdd(this.key, '*', { event: JSON.stringify(event) });
    await batch.exec();
  }
  async read(): Promise<StreamMessage[]> {
    if (!this.groupReady) {
      try {
        await this.client.xGroupCreate(this.key, 'sqlite', '0', { MKSTREAM: true });
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith('BUSYGROUP'))) throw error;
      }
      this.groupReady = true;
    }
    const pending = await this.client.xReadGroup(
      'sqlite',
      'writer',
      { key: this.key, id: '0' },
      { COUNT: 100 },
    );
    if (pending?.[0]?.messages.length) return pending[0].messages;
    const next = await this.client.xReadGroup('sqlite', 'writer', { key: this.key, id: '>' }, { COUNT: 100 });
    return next?.[0]?.messages || [];
  }
  async acknowledge(ids: string[]) {
    if (!ids.length) return;
    await this.client.multi().xAck(this.key, 'sqlite', ids).xDel(this.key, ids).exec();
  }
  close() {
    if (this.client.isOpen) this.client.destroy();
  }
}

/** The disk outbox survives Redis loss and worker termination before a stream ACK. */
export class ActivityQueue {
  private timer?: ReturnType<typeof setInterval>;
  private working?: Promise<void>;
  private published = new Set<string>();
  private stopped = false;
  private sinceFlush = 0;
  error: string | null = null;
  constructor(
    readonly root: string,
    private persist: (events: ActivityEvent[]) => void,
    private options: {
      consume: boolean;
      stream?: ActivityStream;
      onError?: (error: unknown, scope: string) => void;
    },
  ) {
    mkdirSync(root, { recursive: true });
    if (options.consume) {
      this.timer = setInterval(() => {
        void this.flush();
      }, 1000);
      this.timer.unref();
    }
  }
  enqueue(event: ActivityEvent) {
    const path = this.path(event);
    writeFileSync(path + '.tmp', JSON.stringify(event), { mode: 0o600 });
    renameSync(path + '.tmp', path);
    if (++this.sinceFlush >= 100 && this.options.consume) void this.flush();
  }
  private path(event: ActivityEvent) {
    return resolve(this.root, `${event.createdAt}-${event.eventId}.json`);
  }
  private local() {
    const events: ActivityEvent[] = [];
    for (const name of readdirSync(this.root)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(0, 100)) {
      const path = resolve(this.root, name);
      try {
        events.push(eventSchema.parse(JSON.parse(readFileSync(path, 'utf8'))));
      } catch (error) {
        renameSync(path, path + '.corrupt');
        this.options.onError?.(error, 'activity.outbox.corrupt');
      }
    }
    return events;
  }
  flush(): Promise<void> {
    if (this.working) return this.working;
    if (this.stopped || !this.options.consume) return Promise.resolve();
    this.sinceFlush = 0;
    this.working = this.drain()
      .then((fullBatch) => {
        // Catch up after a burst/restart without holding the Gateway event loop.
        if (fullBatch)
          setImmediate(() => {
            if (!this.stopped) void this.flush();
          });
      })
      .catch((error) => {
        this.error = 'Пакет журнала не сохранён. События остаются в локальной очереди.';
        this.options.onError?.(error, 'activity.batch');
      })
      .finally(() => {
        this.working = undefined;
      });
    return this.working;
  }
  private remove(events: ActivityEvent[]) {
    for (const event of events) {
      try {
        unlinkSync(this.path(event));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.published.delete(event.eventId);
    }
  }
  private async drain() {
    const local = this.local();
    const stream = this.options.stream;
    if (!stream?.ready()) {
      this.published.clear();
      if (local.length) {
        this.persist(local);
        this.remove(local);
      }
      this.error = stream ? 'Redis недоступен: журнал записывается пакетами из локальной очереди.' : null;
      return local.length === 100;
    }
    let messages: StreamMessage[];
    try {
      const unpublished = local.filter((event) => !this.published.has(event.eventId));
      if (unpublished.length) {
        await stream.append(unpublished);
        for (const event of unpublished) this.published.add(event.eventId);
      }
      messages = await stream.read();
    } catch (error) {
      // A live TCP connection can still reject writes (e.g. Redis noeviction/OOM).
      this.published.clear();
      if (local.length) {
        this.persist(local);
        this.remove(local);
      }
      if (!this.error) this.options.onError?.(error, 'activity.redis');
      this.error = 'Redis не принимает события: используется локальная пакетная очередь.';
      return local.length === 100;
    }
    if (messages.length) {
      const events = messages.map((item) => eventSchema.parse(JSON.parse(item.message.event)));
      this.persist(events);
      this.remove(events);
      await stream.acknowledge(messages.map((item) => item.id));
    }
    this.error = null;
    return messages.length === 100;
  }
  async close() {
    clearInterval(this.timer);
    await this.flush();
    this.stopped = true;
    this.options.stream?.close();
  }
}

export const activityEventId = () => randomUUID();
