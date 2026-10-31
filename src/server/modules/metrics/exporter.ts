import { createServer, type Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Gauge, Counter, Registry } from '@prometheus-io/client';
import type { Config } from '../../config.js';
import type { Store } from '../../store.js';
import { statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { monitorSummary } from '../game-server-status/state.js';

export class MetricsExporter {
  private server?: Server;
  private cached?: { until: number; body: string };
  private collecting?: Promise<string>;
  constructor(
    private config: Config,
    private store: Store,
    private onError: (error: unknown) => void = () => {},
  ) {}
  async collect() {
    const started = performance.now();
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
    const available = new Gauge({
      name: 'open_bot_worker_telemetry_fresh',
      help: 'Worker has telemetry newer than 30 seconds',
      labelNames: ['worker'],
      registers: [runtime],
    });
    for (const worker of ['bot', 'web'])
      available.set({ worker }, rows.some((row) => row.process === worker) ? 1 : 0);
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
      const entries = (
        await readdir(root, { withFileTypes: true }).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        })
      ).filter((file) => file.isFile() && file.name.endsWith('.json'));
      queues.set({ queue }, entries.length);
      const oldest = new Gauge({
        name: 'open_bot_disk_queue_' + queue + '_oldest_age_seconds',
        help: 'Oldest pending ' + queue + ' disk event age',
        registers: [runtime],
      });
      let age = 0,
        cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(8, entries.length) }, async () => {
          for (;;) {
            const entry = entries[cursor++];
            if (!entry) return;
            try {
              age = Math.max(age, (Date.now() - (await stat(resolve(root, entry.name))).mtimeMs) / 1000);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        }),
      );
      oldest.set(Math.max(0, age));
    }
    const jobs = new Gauge({
      name: 'open_bot_module_jobs',
      help: 'Durable module jobs by kind and state',
      labelNames: ['kind', 'state'],
      registers: [runtime],
    });
    for (const row of this.store.sqlite
      .prepare('SELECT kind,state,COUNT(*) n FROM core_jobs GROUP BY kind,state')
      .all() as { kind: string; state: string; n: number }[])
      jobs.set({ kind: row.kind, state: row.state }, row.n);
    const cases = new Gauge({
      name: 'open_bot_moderation_cases',
      help: 'Moderation cases by action and outcome',
      labelNames: ['action', 'state'],
      registers: [runtime],
    });
    for (const row of this.store.sqlite
      .prepare('SELECT action,state,COUNT(*) n FROM moderation_cases GROUP BY action,state')
      .all() as { action: string; state: string; n: number }[])
      cases.set({ action: row.action, state: row.state }, row.n);
    const deliveries = new Gauge({
      name: 'open_bot_feed_delivery',
      help: 'Subscription delivery states',
      labelNames: ['state'],
      registers: [runtime],
    });
    for (const row of this.store.sqlite
      .prepare('SELECT state,COUNT(*) n FROM feed_delivery GROUP BY state')
      .all() as { state: string; n: number }[])
      deliveries.set({ state: row.state }, row.n);
    const forms = new Gauge({
      name: 'open_bot_form_submissions',
      help: 'Retained form submissions by state',
      labelNames: ['state'],
      registers: [runtime],
    });
    for (const row of this.store.sqlite
      .prepare('SELECT state,COUNT(*) n FROM form_submissions GROUP BY state')
      .all() as { state: string; n: number }[])
      forms.set({ state: row.state }, row.n);
    const gameStates = new Gauge({
      name: 'open_bot_game_servers',
      help: 'Configured servers by game and status; stale or unqueried samples are unknown',
      labelNames: ['game', 'state'],
      registers: [runtime],
    });
    const gameMetrics = Object.fromEntries(
      [
        ['configured', 'open_bot_game_servers_configured', 'Configured game servers'],
        ['players', 'open_bot_game_players', 'Players reported by fresh online servers'],
        ['capacity', 'open_bot_game_capacity', 'Capacity reported by fresh online servers'],
        ['playerSamples', 'open_bot_game_player_samples', 'Fresh online servers reporting a player count'],
        [
          'oldestAge',
          'open_bot_game_oldest_sample_age_seconds',
          'Oldest configured game sample, 999 when never queried',
        ],
        [
          'maxDuration',
          'open_bot_game_query_last_duration_seconds',
          'Maximum last query duration for a game',
        ],
      ].map(([key, name, help]) => [
        key,
        new Gauge({ name, help, labelNames: ['game'], registers: [runtime] }),
      ]),
    );
    for (const summary of monitorSummary(this.store)) {
      for (const state of ['online', 'offline', 'unknown'] as const)
        gameStates.set({ game: summary.game, state }, summary[state]);
      for (const [key, metric] of Object.entries(gameMetrics))
        metric.set({ game: summary.game }, summary[key as Exclude<keyof typeof summary, 'game'>]);
    }
    const jobAge = new Gauge({
      name: 'open_bot_job_oldest_pending_age_seconds',
      help: 'Overdue age of oldest pending durable job',
      labelNames: ['kind'],
      registers: [runtime],
    });
    for (const row of this.store.sqlite
      .prepare(
        "SELECT kind,max(0,(?-min(due_at))/1000.0) age FROM core_jobs WHERE state='pending' GROUP BY kind",
      )
      .all(Date.now()) as { kind: string; age: number }[])
      jobAge.set({ kind: row.kind }, row.age);
    for (const [name, table] of [
      ['giveaways', 'giveaways'],
      ['power_operations', 'power_operations'],
      ['guild_backups', 'guild_backups'],
      ['guild_restores', 'guild_restores'],
    ] as const) {
      const metric = new Gauge({
        name: 'open_bot_' + name,
        help: 'Retained ' + name + ' by state',
        labelNames: ['state'],
        registers: [runtime],
      });
      for (const row of this.store.sqlite
        .prepare(`SELECT state,COUNT(*) n FROM ${table} GROUP BY state`)
        .all() as { state: string; n: number }[])
        metric.set({ state: row.state }, row.n);
    }
    const backupAge = new Gauge({
      name: 'open_bot_guild_backup_last_success_timestamp_seconds',
      help: 'Creation timestamp of most recent successful guild backup; zero when absent',
      registers: [runtime],
    });
    backupAge.set(
      ((
        this.store.sqlite
          .prepare("SELECT max(created_at) time FROM guild_backups WHERE state='ready'")
          .get() as { time: number | null }
      ).time || 0) / 1000,
    );
    const backupEnabled = new Gauge({
      name: 'open_bot_guild_backup_enabled',
      help: 'Scheduled guild backups are enabled',
      registers: [runtime],
    });
    backupEnabled.set(
      (
        this.store.sqlite
          .prepare(
            "SELECT json_extract(document,'$.enabled') enabled FROM module_config WHERE id='guild-backup'",
          )
          .get() as { enabled: number } | undefined
      )?.enabled === 1
        ? 1
        : 0,
    );
    const databaseBytes = new Gauge({
      name: 'open_bot_database_size_bytes',
      help: 'SQLite database and WAL size',
      labelNames: ['file'],
      registers: [runtime],
    });
    for (const [file, path] of [
      ['database', this.config.databasePath],
      ['wal', this.config.databasePath + '-wal'],
    ]) {
      try {
        databaseBytes.set({ file }, statSync(path).size);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        databaseBytes.set({ file }, 0);
      }
    }
    const duration = new Gauge({
      name: 'open_bot_exporter_collection_duration_seconds',
      help: 'Time spent collecting local metrics for this response',
      registers: [runtime],
    });
    duration.set((performance.now() - started) / 1000);
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
        if (!this.cached || this.cached.until < Date.now()) {
          this.collecting ??= this.collect()
            .then((body) => {
              this.cached = { until: Date.now() + 5000, body };
              return body;
            })
            .finally(() => {
              this.collecting = undefined;
            });
          await this.collecting;
        }
        const body = this.cached!.body;
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
