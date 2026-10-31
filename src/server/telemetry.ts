import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from '@prometheus-io/client';
import type { Store } from './store.js';

export const telemetry = new (class {
  readonly registry = new Registry();
  readonly operations = new Counter({
    name: 'open_bot_operations_total',
    help: 'Completed operations',
    labelNames: ['module', 'operation', 'outcome'],
    registers: [this.registry],
  });
  readonly duration = new Histogram({
    name: 'open_bot_operation_duration_seconds',
    help: 'Operation latency',
    labelNames: ['module', 'operation'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 45],
    registers: [this.registry],
  });
  readonly http = new Counter({
    name: 'open_bot_http_requests_total',
    help: 'HTTP requests by registered route',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: 'open_bot_http_duration_seconds',
    help: 'HTTP latency',
    labelNames: ['method', 'route'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15],
    registers: [this.registry],
  });
  readonly errors = new Counter({
    name: 'open_bot_errors_total',
    help: 'Error reports',
    labelNames: ['process'],
    registers: [this.registry],
  });
  readonly moduleUp = new Gauge({
    name: 'open_bot_module_up',
    help: 'Module lifecycle availability',
    labelNames: ['module'],
    registers: [this.registry],
  });
  readonly restarts = new Gauge({
    name: 'open_bot_worker_restarts',
    help: 'Supervisor worker restart count',
    labelNames: ['worker'],
    registers: [this.registry],
  });
  readonly gameProbes = new Counter<'game' | 'outcome'>({
    name: 'open_bot_game_probes_total',
    help: 'Actual game status requests, excluding cached reads',
    labelNames: ['game', 'outcome'],
    registers: [this.registry],
  });
  readonly gameProbeDuration = new Histogram<'game'>({
    name: 'open_bot_game_probe_duration_seconds',
    help: 'Game query completion time including protocol negotiation',
    labelNames: ['game'],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });
  readonly gatewayConnected = new Gauge({
    name: 'open_bot_gateway_connected',
    help: 'Discord Gateway ready state',
    registers: [this.registry],
  });
  readonly gatewayLatency = new Gauge({
    name: 'open_bot_gateway_latency_seconds',
    help: 'Last known Discord Gateway heartbeat latency',
    registers: [this.registry],
  });
  private timer?: ReturnType<typeof setInterval>;
  private defaultMetricsStarted = false;
  observe(module: string, operation: string, outcome: string, started: number) {
    this.operations.inc({ module, operation, outcome });
    this.duration.observe({ module, operation }, (Date.now() - started) / 1000);
  }
  start(store: Store, role: string, onError: (error: unknown) => void) {
    this.registry.setDefaultLabels({ worker: role });
    if (!this.defaultMetricsStarted) {
      collectDefaultMetrics({ register: this.registry, prefix: 'open_bot_' });
      this.defaultMetricsStarted = true;
    }
    let busy = false;
    const snapshot = async () => {
      if (busy) return;
      busy = true;
      try {
        const document = JSON.stringify(await this.registry.getMetricsAsJSON());
        store.sqlite
          .prepare(
            'INSERT INTO metric_snapshots(process,document,updated_at) VALUES(?,?,?) ON CONFLICT(process) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at',
          )
          .run(role, document, Date.now());
      } catch (error) {
        onError(error);
      } finally {
        busy = false;
      }
    };
    this.timer = setInterval(() => void snapshot(), 10000);
    this.timer.unref();
    void snapshot();
  }
  stop() {
    clearInterval(this.timer);
  }
})();
