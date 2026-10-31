import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../store.js';
import type { Config } from '../../config.js';
import type { ActivityService } from '../../activity.js';
import { ModuleStore } from '../../module-store.js';
import { allowedEndpoint, limitedResponse } from '../../module-http.js';
import {
  watchdogConfigSchema,
  powerActionSchema,
  type WatchdogServer,
  type PowerAction,
} from '../../../shared/modules.js';
import { HttpError } from '../../errors.js';
import { telemetry } from '../../telemetry.js';
import { ApplicationSettingsStore } from '../../application-settings.js';
export type PowerOperation = {
  id: string;
  actor: string;
  server_id: string;
  action: PowerAction;
  version: string | null;
  immediate: number;
  state: string;
  created_at: number;
  expires_at: number;
  config_version: number;
  result: string | null;
};
export type PowerBatch = { id: string; actor: string; operations: string; state: string; expires_at: number };
const versionsSchema = z
  .array(
    z.object({
      version: z.string().min(1).max(120),
      current: z.boolean().optional(),
      time: z.union([z.string(), z.number()]).optional(),
    }),
  )
  .max(1000);
export class WatchdogService {
  private configStore: ModuleStore;
  constructor(
    private config: Config,
    private store: Store,
    private activity: ActivityService,
    private onError: (error: unknown, scope: string) => void = () => {},
  ) {
    this.configStore = new ModuleStore(store);
  }
  settings() {
    return this.configStore.get('watchdog', watchdogConfigSchema, { servers: [] });
  }
  save(document: unknown, version: number) {
    const parsed = watchdogConfigSchema.parse(document);
    for (const server of parsed.servers)
      allowedEndpoint(
        server.address,
        new ApplicationSettingsStore(this.store, this.config).get().document.watchdogHosts,
      );
    const targets = parsed.servers.map(
      (server) => new URL(server.address).href.replace(/\/+$/, '') + '/instances/' + server.instance,
    );
    if (new Set(targets).size !== targets.length)
      throw new HttpError(400, 'Один Watchdog instance нельзя добавлять под разными ID');
    return this.store.sqlite
      .transaction(() => {
        if (
          this.store.sqlite
            .prepare("SELECT 1 FROM power_operations WHERE state IN ('running','unknown') LIMIT 1")
            .get()
        )
          throw new HttpError(409, 'Завершите операции и разрешите неизвестные результаты Watchdog');
        return this.configStore.save('watchdog', watchdogConfigSchema, parsed, version);
      })
      .immediate();
  }
  server(id: string) {
    const server = this.settings().document.servers.find((server) => server.id === id);
    if (!server) throw new HttpError(404, 'Watchdog-сервер не найден');
    return server;
  }
  private request(server: WatchdogServer, action: string, params: Record<string, string> = {}) {
    const base = allowedEndpoint(
      server.address,
      new ApplicationSettingsStore(this.store, this.config).get().document.watchdogHosts,
    );
    const url = new URL(
      base.href.replace(/\/$/, '') + `/instances/${encodeURIComponent(server.instance)}/${action}`,
    );
    url.search = new URLSearchParams(params).toString();
    const token = process.env[server.tokenEnv];
    if (!token) throw new HttpError(400, 'Переменная токена Watchdog не заполнена');
    return {
      url,
      headers: { Authorization: 'Basic ' + Buffer.from(server.instance + ':' + token).toString('base64') },
    };
  }
  async versions(id: string) {
    const { url, headers } = this.request(this.server(id), 'versions');
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new HttpError(502, 'Watchdog versions: HTTP ' + response.status);
    return versionsSchema.parse(JSON.parse(await limitedResponse(response)));
  }
  history() {
    return this.store.sqlite
      .prepare('SELECT * FROM power_operations ORDER BY created_at DESC LIMIT 100')
      .all() as PowerOperation[];
  }
  prepare(actor: string, serverId: string, action: PowerAction, version?: string, immediate = false) {
    powerActionSchema.parse(action);
    this.server(serverId);
    if (action === 'revert' && (!version || version.length > 120))
      throw new HttpError(400, 'Укажите версию для отката');
    const id = randomUUID(),
      now = Date.now();
    this.store.sqlite
      .transaction(() => {
        if (
          this.store.sqlite
            .prepare("SELECT 1 FROM power_operations WHERE server_id=? AND state IN ('running','unknown')")
            .get(serverId)
        )
          throw new HttpError(
            409,
            'Есть выполняющаяся операция или неизвестный результат. Проверьте Watchdog перед повтором.',
          );
        this.store.sqlite
          .prepare(
            'INSERT INTO power_operations(id,actor,server_id,action,version,immediate,state,created_at,expires_at,config_version) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            actor,
            serverId,
            action,
            version || null,
            immediate ? 1 : 0,
            'pending',
            now,
            now + 90000,
            this.settings().version,
          );
      })
      .immediate();
    return this.operation(id);
  }
  operation(id: string) {
    const operation = this.store.sqlite.prepare('SELECT * FROM power_operations WHERE id=?').get(id) as
      PowerOperation | undefined;
    if (!operation) throw new HttpError(404, 'Операция не найдена');
    return operation;
  }
  cancel(id: string, actor: string) {
    this.store.sqlite
      .prepare("UPDATE power_operations SET state='cancelled' WHERE id=? AND actor=? AND state='pending'")
      .run(id, actor);
  }
  prepareBatch(actor: string) {
    return this.store.sqlite
      .transaction(() => {
        const servers = this.settings().document.servers;
        if (!servers.length) throw new HttpError(400, 'Серверы не настроены');
        const operations = servers.map((server) => this.prepare(actor, server.id, 'restart').id);
        const id = randomUUID();
        this.store.sqlite
          .prepare(
            "INSERT INTO power_batches(id,actor,operations,state,expires_at) VALUES(?,?,?,'pending',?)",
          )
          .run(id, actor, JSON.stringify(operations), Date.now() + 90000);
        return { id, servers: servers.map((server) => server.id) };
      })
      .immediate();
  }
  cancelBatch(id: string, actor: string) {
    const batch = this.store.sqlite
      .prepare('SELECT * FROM power_batches WHERE id=? AND actor=?')
      .get(id, actor) as PowerBatch | undefined;
    if (!batch || batch.state !== 'pending') throw new HttpError(409, 'Подтверждение недоступно');
    for (const operation of JSON.parse(batch.operations) as string[]) this.cancel(operation, actor);
    this.store.sqlite
      .prepare("UPDATE power_batches SET state='cancelled' WHERE id=? AND state='pending'")
      .run(id);
  }
  async confirmBatch(id: string, actor: { userId: string; name: string }) {
    const batch = this.store.sqlite
      .prepare('SELECT * FROM power_batches WHERE id=? AND actor=?')
      .get(id, actor.userId) as PowerBatch | undefined;
    if (
      !batch ||
      !this.store.sqlite
        .prepare(
          "UPDATE power_batches SET state='running' WHERE id=? AND actor=? AND state='pending' AND expires_at>?",
        )
        .run(id, actor.userId, Date.now()).changes
    )
      throw new HttpError(409, 'Подтверждение устарело или уже использовано');
    const ids = JSON.parse(batch.operations) as string[],
      results: PowerOperation[] = [];
    for (let i = 0; i < ids.length; i += 5)
      results.push(
        ...(await Promise.all(
          ids.slice(i, i + 5).map(async (id) => {
            try {
              return await this.confirm(id, actor);
            } catch (error) {
              const operation = this.operation(id);
              return {
                ...operation,
                result: error instanceof HttpError ? error.message : 'Действие не выполнено',
              };
            }
          }),
        )),
      );
    this.store.sqlite
      .prepare('UPDATE power_batches SET state=? WHERE id=?')
      .run(results.every((result) => result.state === 'succeeded') ? 'succeeded' : 'partial', id);
    return results;
  }
  resolve(id: string, actor: { userId: string; name: string }) {
    const operation = this.operation(id);
    if (operation.state !== 'unknown') throw new HttpError(409, 'Операция не требует ручной проверки');
    this.store.sqlite
      .prepare("UPDATE power_operations SET state='resolved',result=? WHERE id=? AND state='unknown'")
      .run('Состояние проверено администратором ' + actor.userId, id);
    this.activity.record(actor, {
      kind: 'watchdog.resolve',
      target: id,
      summary: 'Администратор подтвердил ручную проверку результата Watchdog',
    });
  }
  recover() {
    this.store.sqlite
      .prepare(
        "UPDATE power_operations SET state='unknown',result='Процесс прерван: проверьте сервер вручную. Автоматического повтора не было.' WHERE state='running' AND created_at<?",
      )
      .run(Date.now() - 30000);
    this.store.sqlite
      .prepare("UPDATE power_operations SET state='expired' WHERE state='pending' AND expires_at<?")
      .run(Date.now());
  }
  async confirm(id: string, actor: { userId: string; name: string }) {
    const operation = this.operation(id);
    if (operation.actor !== actor.userId) throw new HttpError(403, 'Подтвердить может только инициатор');
    const snapshot = this.settings();
    if (operation.config_version !== snapshot.version)
      throw new HttpError(409, 'Настройки изменились. Создайте новую операцию.');
    const server = this.server(operation.server_id);
    // Resolve credentials before entering running state; there is no remote action yet.
    const { url, headers } = this.request(
      server,
      operation.action,
      operation.action === 'revert'
        ? { version: operation.version!, immediate: String(Boolean(operation.immediate)) }
        : {},
    );
    if (
      operation.action === 'revert' &&
      !(await this.versions(server.id)).some((version) => version.version === operation.version)
    )
      throw new HttpError(400, 'Выбранной версии нет в Watchdog');
    try {
      const changed = this.store.sqlite
        .prepare(
          "UPDATE power_operations SET state='running',created_at=? WHERE id=? AND actor=? AND state='pending' AND expires_at>? AND config_version=(SELECT version FROM module_config WHERE id='watchdog') AND NOT EXISTS(SELECT 1 FROM power_operations other WHERE other.server_id=power_operations.server_id AND other.state='unknown')",
        )
        .run(Date.now(), id, actor.userId, Date.now());
      if (!changed.changes) throw new HttpError(409, 'Подтверждение устарело или уже использовано');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, 'Для сервера уже выполняется действие');
    }
    this.activity.record(actor, {
      kind: 'watchdog.start',
      target: id,
      summary: `Watchdog: ${operation.action} ${server.id}`,
      details: {
        server: server.id,
        action: operation.action,
        version: operation.version,
        immediate: Boolean(operation.immediate),
      },
    });
    const started = Date.now();
    let state = 'unknown',
      result = 'Ответ не получен. Проверьте сервер вручную; автоматического повтора нет.';
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      await limitedResponse(response);
      if (response.status >= 200 && response.status < 300) {
        state = 'succeeded';
        result = 'Watchdog принял запрос. Завершение действия проверяйте по статусу сервера.';
      } else if (response.status >= 400 && response.status < 500) {
        state = 'failed';
        result = 'Watchdog отклонил запрос: HTTP ' + response.status;
      } else result = 'Watchdog вернул HTTP ' + response.status + '. Результат требует ручной проверки.';
    } catch {
      /* A lost response must never trigger a repeated POST. */
    }
    this.store.sqlite
      .prepare('UPDATE power_operations SET state=?,result=? WHERE id=?')
      .run(state, result, id);
    if (state !== 'succeeded')
      this.onError(new Error(`Watchdog ${operation.action}: ${result}`), 'watchdog.action');
    telemetry.observe('watchdog', operation.action, state, started);
    this.activity.record(actor, {
      kind: 'watchdog.result',
      target: id,
      summary: result,
      details: { server: server.id, action: operation.action, state },
    });
    return this.operation(id);
  }
}
