import { fork, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config } from '../config.js';
import { ErrorReporter } from './error-reporter.js';
import type { ProcessState, RuntimeStatus } from './types.js';
import { z } from 'zod';

const heartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  state: z.enum(['starting', 'running']),
  ready: z.boolean(),
  activityError: z.string().nullable().optional(),
  modules: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      state: z.enum(['starting', 'running', 'failed']),
      errorId: z.string().optional(),
    }),
  ),
});

type Slot = {
  child?: ChildProcess;
  started: number;
  lastBeat: number;
  readySince: number;
  unreadySince: number;
  failures: number;
  restarts: number;
  timer?: ReturnType<typeof setTimeout>;
  stderr: string;
  state: ProcessState;
};
export async function supervise(config: Config) {
  const errors = new ErrorReporter(config, 'supervisor');
  let stopping = false;
  const root = dirname(config.databasePath);
  mkdirSync(root, { recursive: true });
  const lock = resolve(root, 'supervisor.lock');
  if (existsSync(lock)) {
    const old = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
    let alive = true;
    try {
      process.kill(old.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      else throw error;
    }
    if (alive) throw new Error('Another Open Bot supervisor is running (PID ' + old.pid + ')');
    unlinkSync(lock);
  }
  const lockFile = openSync(lock, 'wx');
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
  closeSync(lockFile);
  const empty = (): Slot => ({
    started: 0,
    lastBeat: 0,
    readySince: 0,
    unreadySince: 0,
    failures: 0,
    restarts: 0,
    stderr: '',
    state: { pid: null, state: 'starting', ready: false, restarts: 0, lastBeat: 0, modules: [] },
  });
  const slots = { bot: empty(), web: empty() };
  const snapshot = (): RuntimeStatus => ({ bot: { ...slots.bot.state }, web: { ...slots.web.state } });
  function send(child: ChildProcess, message: Parameters<ChildProcess['send']>[0]) {
    if (child.connected)
      child.send(message, (error) => {
        if (error && !stopping) errors.report(error, 'supervisor.ipc');
      });
  }
  function broadcast() {
    const status = snapshot();
    for (const slot of Object.values(slots)) if (slot.child) send(slot.child, { type: 'status', status });
  }
  errors.startDelivery(() => slots.bot.state.ready);
  let monitor: ReturnType<typeof setInterval> | undefined;
  async function shutdown(code: number) {
    if (stopping) return;
    stopping = true;
    clearInterval(monitor);
    for (const slot of Object.values(slots)) {
      clearTimeout(slot.timer);
      if (slot.child) send(slot.child, { type: 'shutdown' });
    }
    const deadline = setTimeout(() => {
      for (const slot of Object.values(slots)) slot.child?.kill('SIGKILL');
    }, 9000);
    deadline.unref();
    await Promise.all(
      Object.values(slots).map((slot) =>
        slot.child && slot.child.exitCode === null
          ? new Promise<void>((resolve) => slot.child!.once('exit', () => resolve()))
          : Promise.resolve(),
      ),
    );
    clearTimeout(deadline);
    errors.stop();
    try {
      if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) unlinkSync(lock);
    } catch (error) {
      errors.report(error, 'supervisor.lock-cleanup');
    }
    process.exit(code);
  }
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));
  const fatal = (error: unknown, scope: string) => {
    errors.report(error, scope, {}, true);
    void shutdown(1);
  };
  process.on('uncaughtException', (error) => fatal(error, 'supervisor.uncaughtException'));
  process.on('unhandledRejection', (error) => fatal(error, 'supervisor.unhandledRejection'));
  function start(role: 'bot' | 'web') {
    if (stopping) return;
    const slot = slots[role];
    slot.started = Date.now();
    slot.lastBeat = Date.now();
    slot.readySince = 0;
    slot.unreadySince = Date.now();
    slot.stderr = '';
    const worker = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url);
    const child = fork(worker, [], {
      env: { ...process.env, OS_WORKER_ROLE: role },
      execArgv: [
        ...process.execArgv.filter(
          (argument) => !argument.startsWith('--max-old-space-size') && argument !== '--enable-source-maps',
        ),
        '--enable-source-maps',
        '--max-old-space-size=384',
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    slot.child = child;
    slot.state = {
      pid: child.pid || null,
      state: 'starting',
      ready: false,
      restarts: slot.restarts,
      lastBeat: Date.now(),
      modules: [],
    };
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(errors.redact(chunk.toString())));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = errors.redact(chunk.toString());
      slot.stderr = (slot.stderr + text).slice(-12000);
      process.stderr.write(text);
    });
    child.on('message', (message: unknown) => {
      const parsed = heartbeatSchema.safeParse(message);
      if (!parsed.success) return;
      const beat = parsed.data;
      slot.lastBeat = Date.now();
      if (beat.ready) {
        if (!slot.readySince) slot.readySince = Date.now();
        slot.unreadySince = 0;
        if (Date.now() - slot.readySince > 60000) slot.failures = 0;
      } else {
        slot.readySince = 0;
        if (!slot.unreadySince) slot.unreadySince = Date.now();
      }
      slot.state = {
        ...slot.state,
        state: beat.state,
        ready: beat.ready,
        activityError: beat.activityError,
        lastBeat: slot.lastBeat,
        modules: beat.modules,
      };
      broadcast();
    });
    child.on('error', (error) => errors.report(error, 'supervisor.spawn', { role }));
    child.once('close', (code, signal) => {
      slot.child = undefined;
      slot.state = { ...slot.state, ready: false, pid: null, state: stopping ? 'stopped' : 'restarting' };
      broadcast();
      if (stopping) return;
      errors.report(
        new Error('Worker exited: code=' + code + ', signal=' + signal),
        'supervisor.worker-exit',
        { role, stderr: slot.stderr },
        true,
      );
      const delay =
        Math.min(60000, 1000 * 2 ** Math.min(slot.failures++, 6)) + Math.floor(Math.random() * 500);
      slot.restarts++;
      slot.state.restarts = slot.restarts;
      slot.timer = setTimeout(() => start(role), delay);
    });
    send(child, { type: 'status', status: snapshot() });
  }
  try {
    // Apply migrations before either process opens the shared WAL database.
    const [{ Store }, { loadSeed }] = await Promise.all([import('../store.js'), import('../seed.js')]);
    const store = new Store(config.databasePath, config.guildId, loadSeed(), config.adminRoleId);
    store.close();
    start('bot');
    start('web');
    monitor = setInterval(() => {
      for (const [role, slot] of Object.entries(slots)) {
        const timeout =
          Date.now() - slot.lastBeat > 30000 ||
          (role === 'bot' &&
            slot.state.state === 'running' &&
            !slot.state.ready &&
            slot.unreadySince > 0 &&
            Date.now() - slot.unreadySince > 120000) ||
          (slot.state.state === 'starting' && Date.now() - slot.started > 60000);
        if (slot.child && timeout) {
          errors.report(
            new Error('Worker heartbeat/startup deadline exceeded'),
            'supervisor.watchdog',
            { role, pid: slot.child.pid, lastBeat: slot.lastBeat },
            true,
          );
          slot.lastBeat = Date.now();
          slot.child.kill('SIGKILL');
        }
      }
    }, 5000);
    console.info(JSON.stringify({ kind: 'supervisor.ready', pid: process.pid, workers: ['bot', 'web'] }));
  } catch (error) {
    errors.report(error, 'supervisor.bootstrap', {}, true);
    await errors.flush(false);
    await shutdown(1);
  }
}
