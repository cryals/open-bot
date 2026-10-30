import { createServer, type Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Gauge, Counter, Registry } from '@prometheus-io/client';
import type { Config } from '../../config.js';
import type { Store } from '../../store.js';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class MetricsExporter {
  private server?: Server;
  constructor(
    private config: Config,
    private store: Store,
    private onError: (error: unknown) => void = () => {},
  ) {}
  async collect() {
    const rows = this.store.sqlite
      .prepare('SELECT * FROM metric_snapshots WHERE updated_at>?')
      .all(Date.now() - 30000) as { process: string; document: string; updated_at: number }[];
    const registry = Registry.aggregate(
      rows.map((row) => JSON.parse(row.document) as Awaited<ReturnType<Registry['getMetricsAsJSON']>>),
    );
    const runtime = new Registry();
    const fresh = new Gauge({
      name: 'open_bot_worker_snapshot_age_seconds',
      help: 'Seconds since last worker telemetry snapshot',
      labelNames: ['worker'],
      registers: [runtime],
    });
    for (const role of ['bot', 'web'])
      fresh.set(
        { worker: role },
        rows.find((row) => row.process === role)
          ? (Date.now() - rows.find((row) => row.process === role)!.updated_at) / 1000
          : 999,
      );
    const states = new Gauge({
      name: 'open_bot_tickets',
      help: 'Tickets by state',
      labelNames: ['state'],
      registers: [runtime],
    });
    for (const row of this.store.sqlite
      .prepare('SELECT state,COUNT(*) count FROM tickets GROUP BY state')
      .all() as { state: string; count: number }[])
      states.set({ state: row.state }, row.count);
    const total = this.store.sqlite.prepare('SELECT * FROM ticket_totals WHERE id=1').get() as Record<
      string,
      number
    >;
    for (const [key, name] of [
      ['created', 'created_total'],
      ['closed', 'closed_total'],
      ['first_responses', 'first_responses_total'],
      ['first_response_seconds', 'first_response_seconds_total'],
      ['resolution_seconds', 'resolution_seconds_total'],
    ]) {
      const counter = new Counter({
        name: 'open_bot_ticket_' + name,
        help: 'Persistent ticket aggregate ' + key,
        registers: [runtime],
      });
      counter.inc(total[key]);
    }
    const pending = new Gauge({
      name: 'open_bot_ticket_pending_jobs',
      help: 'Ticket lifecycle jobs awaiting completion',
      registers: [runtime],
    });
    pending.set(
      (
        this.store.sqlite
          .prepare(
            "SELECT (SELECT COUNT(*) FROM tickets WHERE state IN ('creating','closing','purging'))+(SELECT COUNT(*) FROM ticket_jobs) n",
          )
          .get() as { n: number }
      ).n,
    );
    const queues = new Gauge({
      name: 'open_bot_disk_queue_items',
      help: 'Pending disk queue files',
      labelNames: ['queue'],
      registers: [runtime],
    });
    for (const [queue, path] of [
      ['activity', 'activity-outbox'],
      ['errors', 'errors/pending'],
    ]) {
      const root = resolve(dirname(this.config.databasePath), path);
      queues.set(
        { queue },
        existsSync(root)
          ? readdirSync(root, { withFileTypes: true }).filter(
              (file) => file.name.endsWith('.json') && file.isFile(),
            ).length
          : 0,
      );
    }
    return (await registry.metrics()) + '\n' + (await runtime.metrics());
  }
  async start() {
    if (!this.config.metricsToken || this.config.metricsToken.length < 32)
      throw new Error('Metrics requires a bearer token of at least 32 characters');
    const expected = createHash('sha256')
      .update(this.config.metricsToken || '')
      .digest();
    this.server = createServer(async (request, response) => {
      const supplied = createHash('sha256')
        .update((request.headers.authorization || '').replace(/^Bearer /, ''))
        .digest();
      if (!timingSafeEqual(expected, supplied)) {
        response.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
        return;
      }
      if (request.method !== 'GET' || request.url !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      try {
        const body = await this.collect();
        response
          .writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          .end(body);
      } catch (error) {
        this.onError(error);
        response.writeHead(503).end('Metrics unavailable');
      }
    });
    this.server.requestTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.metricsPort ?? 9091, this.config.metricsHost || '127.0.0.1', resolve);
    });
  }
  async stop() {
    await new Promise<void>((resolve, reject) =>
      this.server ? this.server.close((error) => (error ? reject(error) : resolve())) : resolve(),
    );
  }
  address() {
    return this.server?.address();
  }
}
