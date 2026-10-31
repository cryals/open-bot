import { documentation } from './documentation.js';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { Access, ServerConfig, WatchdogConfig, PowerAction } from '../shared/modules.js';
import type { GuildInfo } from '../shared/rules.js';
import type { ServerStatus } from '../server/modules/game-server-status/service.js';
import type { PowerOperation } from '../server/modules/watchdog/service.js';
import { Tickets } from './Tickets.js';
import './modules.css';
import { Community } from './Community.js';
import { Moderation } from './Moderation.js';
export type ModuleKind = 'tickets' | 'servers' | 'watchdog' | 'metrics' | 'community' | 'moderation';
type Snapshot = {
  servers: { document: ServerConfig; version: number };
  watches: {
    id: number;
    server_id: string;
    channel_id: string;
    message_id: string | null;
    error: string | null;
    enabled: number;
  }[];
  watchdog: { document: WatchdogConfig; version: number };
  operations: PowerOperation[];
  gameServerHosts: string[];
  watchdogHosts: string[];
  tokenNames: string[];
  metrics: { enabled: boolean; host: string; port: number };
};
export function Modules(props: { kind: ModuleKind; access: Access; guild?: GuildInfo | null }) {
  if (props.kind === 'community') return <Community access={props.access} />;
  if (props.kind === 'moderation') return <Moderation access={props.access} />;
  return <ExistingModules {...props} />;
}
function ExistingModules({
  kind,
  access,
  guild,
}: {
  kind: ModuleKind;
  access: Access;
  guild?: GuildInfo | null;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [servers, setServers] = useState<ServerConfig>({ servers: [] }),
    [watchdog, setWatchdog] = useState<WatchdogConfig>({ servers: [] });
  const [status, setStatus] = useState<Record<string, ServerStatus>>({}),
    [watchServer, setWatchServer] = useState(''),
    [watchChannel, setWatchChannel] = useState('');
  const [powerServer, setPowerServer] = useState(''),
    [powerAction, setPowerAction] = useState<PowerAction>('restart'),
    [powerVersion, setPowerVersion] = useState(''),
    [immediate, setImmediate] = useState(false),
    [versions, setVersions] = useState<{ version: string; current?: boolean }[]>([]),
    [pending, setPending] = useState<PowerOperation | null>(null),
    [network, setNetwork] = useState<{ id: string; servers: string[] } | null>(null),
    [result, setResult] = useState('');
  const serverDirty = snapshot && JSON.stringify(servers) !== JSON.stringify(snapshot.servers.document),
    powerDirty = snapshot && JSON.stringify(watchdog) !== JSON.stringify(snapshot.watchdog.document);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (serverDirty || powerDirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [serverDirty, powerDirty]);
  async function load(replace = false) {
    const next = await api<Snapshot>('/modules');
    setSnapshot(next);
    if (replace) {
      setServers(next.servers.document);
      setWatchdog(next.watchdog.document);
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (access.admin) void run(() => load(true));
  }, [access.admin]);
  return (
    <div className="module-workspace">
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div hidden={kind !== 'tickets'}>
        <Tickets access={access} active={kind === 'tickets'} />
      </div>
      {access.admin && snapshot && (
        <>
          <div hidden={kind !== 'servers'}>
            <section className="module-card">
              <h2>SS14-серверы</h2>
              <p>
                Адреса ss14:// и ss14s:// преобразуются в HTTP /status. Разрешённые хосты:{' '}
                {snapshot.gameServerHosts.join(', ') || 'не заданы — откройте настройки приложения'}. Опрос
                кешируется на 15 секунд; наблюдения обновляются раз в минуту.
              </p>
              {servers.servers.map((server, index) => (
                <div className="module-card" key={index}>
                  <div className="module-grid">
                    {(['id', 'name', 'address'] as const).map((field) => (
                      <label key={field}>
                        {{ id: 'ID сервера', name: 'Название', address: 'Адрес SS14' }[field]}
                        <input
                          value={server[field]}
                          data-no-audit={field === 'address' ? true : undefined}
                          onChange={(event) =>
                            setServers({
                              servers: servers.servers.map((item, i) =>
                                i === index ? { ...item, [field]: event.target.value } : item,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <div className="module-toolbar">
                    <button
                      className="button"
                      onClick={() => setServers({ servers: servers.servers.filter((_, i) => i !== index) })}
                    >
                      Удалить
                    </button>
                    <button
                      className="button"
                      disabled={busy || Boolean(serverDirty)}
                      onClick={() =>
                        void run(async () => {
                          const result = await api<ServerStatus>('/modules/servers/' + server.id);
                          setStatus((previous) => ({ ...previous, [server.id]: result }));
                        })
                      }
                    >
                      Проверить статус
                    </button>
                  </div>
                  {status[server.id] && (
                    <p>
                      {status[server.id].name} · {status[server.id].status} · Игроки{' '}
                      {status[server.id].players} · {status[server.id].map} · {status[server.id].preset} ·
                      Раунд {status[server.id].roundId}
                      {status[server.id].error ? ' · ' + status[server.id].error : ''}
                    </p>
                  )}
                </div>
              ))}
              <div className="module-toolbar">
                <button
                  className="button"
                  onClick={() =>
                    setServers({
                      servers: [
                        ...servers.servers,
                        {
                          id: 'server-' + (servers.servers.length + 1),
                          name: 'Новый сервер',
                          address: 'ss14s://example.com',
                        },
                      ],
                    })
                  }
                >
                  Добавить сервер
                </button>
                <button
                  className="button primary"
                  disabled={busy || !serverDirty}
                  onClick={() =>
                    void run(async () => {
                      const saved = await api<Snapshot['servers']>('/modules/servers', 'PUT', {
                        document: servers,
                        version: snapshot.servers.version,
                      });
                      setSnapshot({ ...snapshot, servers: saved });
                    })
                  }
                >
                  Сохранить серверы
                </button>
              </div>
            </section>
            <section className="module-card">
              <h2>Обновляемые сообщения</h2>
              <div className="module-toolbar">
                <select
                  aria-label="Сервер наблюдения"
                  value={watchServer}
                  onChange={(event) => setWatchServer(event.target.value)}
                >
                  <option value="">Выберите сервер</option>
                  {snapshot.servers.document.servers.map((server) => (
                    <option value={server.id} key={server.id}>
                      {server.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Канал статуса"
                  value={watchChannel}
                  onChange={(event) => setWatchChannel(event.target.value)}
                >
                  <option value="">Канал</option>
                  {guild?.channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      #{channel.name}
                    </option>
                  ))}
                </select>
                <button
                  className="button"
                  disabled={busy || !watchServer || !watchChannel}
                  onClick={() =>
                    void run(async () => {
                      if (!window.confirm('Создать обновляемое сообщение статуса в выбранном канале?'))
                        return;
                      await api('/modules/watches', 'POST', {
                        serverId: watchServer,
                        channelId: watchChannel,
                      });
                      await load();
                    })
                  }
                >
                  Добавить наблюдение
                </button>
                <button className="button" onClick={() => void run(() => load())}>
                  Обновить список
                </button>
              </div>
              {snapshot.watches.map((watch) => (
                <div className="module-toolbar" key={watch.id}>
                  <span>
                    #{watch.id} · {watch.server_id} · канал {watch.channel_id}
                    {watch.error ? ' · ' + watch.error : ''}
                    {!watch.enabled ? ' · удаляется' : ''}
                  </span>
                  <button
                    className="button"
                    onClick={() =>
                      void run(async () => {
                        await api('/modules/watches/' + watch.id, 'DELETE');
                        await load();
                      })
                    }
                  >
                    Убрать
                  </button>
                </div>
              ))}
            </section>
          </div>
          <div hidden={kind !== 'watchdog'}>
            <section className="module-card">
              <h2>SS14 Watchdog</h2>
              <p>
                Разрешённые хосты: {snapshot.watchdogHosts.join(', ') || 'укажите в настройках приложения'}.
                Токен указывается именем переменной WATCHDOG_TOKEN_…; его значение не передаётся браузеру.
              </p>
              {watchdog.servers.map((server, index) => (
                <div className="module-card" key={index}>
                  <div className="module-grid">
                    {(['id', 'name', 'address', 'instance', 'tokenEnv'] as const).map((field) => (
                      <label key={field}>
                        {
                          {
                            id: 'ID сервера',
                            name: 'Название',
                            address: 'Базовый URL Watchdog',
                            instance: 'Instance ID',
                            tokenEnv: 'Переменная токена ENV',
                          }[field]
                        }
                        <input
                          data-no-audit={field === 'tokenEnv' || field === 'address' ? true : undefined}
                          list={field === 'tokenEnv' ? 'watchdog-env' : undefined}
                          value={server[field]}
                          onChange={(event) =>
                            setWatchdog({
                              servers: watchdog.servers.map((item, i) =>
                                i === index ? { ...item, [field]: event.target.value } : item,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    className="button"
                    onClick={() => setWatchdog({ servers: watchdog.servers.filter((_, i) => i !== index) })}
                  >
                    Удалить сервер
                  </button>
                </div>
              ))}
              <datalist id="watchdog-env">
                {snapshot.tokenNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <div className="module-toolbar">
                <button
                  className="button"
                  onClick={() =>
                    setWatchdog({
                      servers: [
                        ...watchdog.servers,
                        {
                          id: 'server-' + (watchdog.servers.length + 1),
                          name: 'Новый сервер',
                          address: 'https://example.com/watchdog',
                          instance: 'main',
                          tokenEnv: 'WATCHDOG_TOKEN_MAIN',
                        },
                      ],
                    })
                  }
                >
                  Добавить Watchdog
                </button>
                <button
                  className="button primary"
                  disabled={busy || !powerDirty}
                  onClick={() =>
                    void run(async () => {
                      const saved = await api<Snapshot['watchdog']>('/modules/watchdog', 'PUT', {
                        document: watchdog,
                        version: snapshot.watchdog.version,
                      });
                      setSnapshot({ ...snapshot, watchdog: saved });
                    })
                  }
                >
                  Сохранить Watchdog
                </button>
              </div>
            </section>
            <section className="module-card">
              <h2>Действие с сервером</h2>
              <div className="module-grid">
                <label>
                  Сервер
                  <select
                    value={powerServer}
                    onChange={(event) => {
                      setPowerServer(event.target.value);
                      setVersions([]);
                      setPowerVersion('');
                    }}
                  >
                    <option value="">Выберите сервер</option>
                    {snapshot.watchdog.document.servers.map((server) => (
                      <option key={server.id} value={server.id}>
                        {server.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Действие
                  <select
                    value={powerAction}
                    onChange={(event) => setPowerAction(event.target.value as PowerAction)}
                  >
                    <option value="restart">Restart</option>
                    <option value="update">Update</option>
                    <option value="stop">Stop после раунда</option>
                    <option value="revert">Revert</option>
                  </select>
                </label>
                {powerAction === 'revert' && (
                  <>
                    <button
                      className="button"
                      disabled={busy || !powerServer}
                      onClick={() =>
                        void run(async () =>
                          setVersions(await api('/modules/watchdog/' + powerServer + '/versions')),
                        )
                      }
                    >
                      Получить версии
                    </button>
                    <label>
                      Версия
                      <select value={powerVersion} onChange={(event) => setPowerVersion(event.target.value)}>
                        <option value="">Выберите версию</option>
                        {versions.map((version) => (
                          <option value={version.version} key={version.version}>
                            {version.version}
                            {version.current ? ' · текущая' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={immediate}
                        onChange={(event) => setImmediate(event.target.checked)}
                      />
                      Прервать раунд при откате
                    </label>
                  </>
                )}
              </div>
              <button
                className="button primary"
                disabled={
                  busy || !powerServer || Boolean(powerDirty) || (powerAction === 'revert' && !powerVersion)
                }
                onClick={() =>
                  void run(async () =>
                    setPending(
                      await api('/modules/watchdog/prepare', 'POST', {
                        serverId: powerServer,
                        action: powerAction,
                        ...(powerAction === 'revert' ? { version: powerVersion, immediate } : {}),
                      }),
                    ),
                  )
                }
              >
                Подготовить действие
              </button>
              <button
                className="button"
                disabled={busy || Boolean(powerDirty) || !snapshot.watchdog.document.servers.length}
                onClick={() =>
                  void run(async () => setNetwork(await api('/modules/watchdog/network', 'POST')))
                }
              >
                Подготовить перезапуск сети
              </button>
              {network && (
                <div className="module-confirm" role="alert">
                  <h3>Перезапустить всю сеть?</h3>
                  <p>Серверы: {network.servers.join(', ')}. Подтверждение действительно 90 секунд.</p>
                  <div className="module-toolbar">
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const results = await api<PowerOperation[]>(
                            '/modules/watchdog/network/' + network.id + '/confirm',
                            'POST',
                          );
                          setNetwork(null);
                          setResult(
                            results.map((result) => result.server_id + ': ' + result.state).join('; '),
                          );
                          await load();
                        })
                      }
                    >
                      Подтвердить перезапуск сети
                    </button>
                    <button
                      className="button"
                      onClick={() =>
                        void run(async () => {
                          await api('/modules/watchdog/network/' + network.id + '/cancel', 'POST');
                          setNetwork(null);
                        })
                      }
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}
              {pending && (
                <div className="module-confirm" role="alert">
                  <h3>
                    Подтвердить {pending.action}: {pending.server_id}?
                  </h3>
                  <p>
                    Версия: {pending.version || '—'} ·{' '}
                    {pending.immediate ? 'С немедленным прерыванием раунда' : 'Обычный режим'}. Подтверждение
                    действует 90 секунд.
                  </p>
                  <div className="module-toolbar">
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const operation = await api<PowerOperation>(
                            '/modules/watchdog/' + pending.id + '/confirm',
                            'POST',
                          );
                          setPending(null);
                          setResult(operation.result || operation.state);
                          await load();
                        })
                      }
                    >
                      Подтвердить выполнение
                    </button>
                    <button
                      className="button"
                      onClick={() =>
                        void run(async () => {
                          await api('/modules/watchdog/' + pending.id + '/cancel', 'POST');
                          setPending(null);
                        })
                      }
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}
              {result && <p role="status">{result}</p>}
            </section>
            <section className="module-card">
              <h2>История операций</h2>
              <button className="button" onClick={() => void run(() => load())}>
                Обновить
              </button>
              {snapshot.operations.map((operation) => (
                <div className="module-card" key={operation.id}>
                  <p>
                    {new Date(operation.created_at).toLocaleString('ru')} · {operation.server_id} ·{' '}
                    {operation.action} · {operation.state}
                  </p>
                  <p>{operation.result}</p>
                  {operation.state === 'unknown' && (
                    <button
                      className="button"
                      onClick={() =>
                        void run(async () => {
                          if (
                            !window.confirm(
                              'Вы проверили реальное состояние сервера и готовы разрешить новые действия?',
                            )
                          )
                            return;
                          await api('/modules/watchdog/' + operation.id + '/resolve', 'POST');
                          await load();
                        })
                      }
                    >
                      Подтвердить ручную проверку
                    </button>
                  )}
                </div>
              ))}
            </section>
          </div>
          <div hidden={kind !== 'metrics'}>
            <section className="module-card">
              <h2>Prometheus / Grafana</h2>
              <p>
                Экспортёр: {snapshot.metrics.enabled ? 'включён' : 'выключен'}. Адрес прослушивания:{' '}
                {snapshot.metrics.host}:{snapshot.metrics.port}/metrics. Токен не показывается в панели.
              </p>
              <p>
                Endpoint использует отдельный bearer token. Метрики Bot и Web поступают через снимки раз в 10
                секунд; экспортёр работает отдельным процессом.
              </p>
              <pre>
                {
                  'METRICS_HOST=127.0.0.1\nMETRICS_PORT=9091\nMETRICS_TOKEN=<случайный секрет, минимум 32 символа>'
                }
              </pre>
              <p>
                <a className="button" href="/monitoring/grafana.json" download>
                  Скачать dashboard Grafana
                </a>
              </p>
              <p>
                В Grafana импортируйте JSON и выберите существующий Prometheus datasource. Настройку scrape
                смотрите в документации модуля.
              </p>
              <a href={documentation('developer/telemetry')} target="_blank" rel="noreferrer">
                Документация телеметрии
              </a>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
