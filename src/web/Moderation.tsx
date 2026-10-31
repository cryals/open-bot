import { useEffect, useState } from 'react';
import { api } from './api.js';
import {
  actionTitles,
  initialModerationConfig,
  initialModLogConfig,
  moderationConfigSchema,
  type ModerationCase,
  type ModerationAction,
} from '../shared/moderation.js';
import { BlockEditor } from './BlockEditor.js';
import type { Access } from '../shared/modules.js';
import { ConfigEditor, type JsonSchema } from './ConfigEditor.js';
import { z } from 'zod';
export function Moderation({ access }: { access: Access }) {
  const [rows, setRows] = useState<ModerationCase[]>([]),
    [target, setTarget] = useState(''),
    [action, setAction] = useState<ModerationAction>('warn'),
    [reason, setReason] = useState(''),
    [duration, setDuration] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [prepared, setPrepared] = useState<ModerationCase | null>(null),
    [detail, setDetail] = useState<{ case: ModerationCase; history: unknown[] } | null>(null);
  const [config, setConfig] = useState({ document: initialModerationConfig, version: 0 }),
    [logs, setLogs] = useState({ document: initialModLogConfig, version: 0 }),
    [tab, setTab] = useState('cases');
  const [purge, setPurge] = useState({
    count: 20,
    author: '',
    contains: '',
    type: 'all',
    includePinned: false,
  });
  async function load() {
    const data = await api<{ cases: ModerationCase[] }>(
      '/moderation' + (target ? '?target=' + encodeURIComponent(target) : ''),
    );
    setRows(data.cases);
    if (access.moderationManage) {
      const next = await api<{ moderation: typeof config; logs: typeof logs }>('/moderation/settings');
      setConfig(next.moderation);
      setLogs(next.logs);
    }
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(load);
  }, []);
  return (
    <div className="module-workspace">
      {!access.admin && <h1>Модерация</h1>}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="toolbar">
        <button className="button" onClick={() => setTab('cases')}>
          Дела
        </button>
        {access.moderationManage && (
          <button className="button" onClick={() => setTab('settings')}>
            Настройки и журнал
          </button>
        )}
        <button className="button" disabled={busy} onClick={() => void run(load)}>
          Обновить
        </button>
      </div>
      {tab === 'cases' ? (
        <>
          <section className="module-card">
            <label>
              ID участника / канала
              <input value={target} onChange={(event) => setTarget(event.target.value)} />
            </label>
            <button className="button" onClick={() => void run(load)}>
              Фильтровать
            </button>
            {access.moderationManage && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    setPrepared(
                      await api<ModerationCase>('/moderation/prepare', 'POST', {
                        action,
                        target,
                        reason,
                        duration: duration ? Number(duration) : null,
                        deleteSeconds: 0,
                        purge:
                          action === 'purge'
                            ? {
                                ...purge,
                                author: purge.author || undefined,
                                contains: purge.contains || undefined,
                              }
                            : undefined,
                        operationId: crypto.randomUUID(),
                      }),
                    );
                  });
                }}
              >
                <label>
                  Действие
                  <select
                    value={action}
                    onChange={(event) => setAction(event.target.value as ModerationAction)}
                  >
                    {Object.entries(actionTitles).map(([key, title]) => (
                      <option key={key} value={key}>
                        {title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Причина
                  <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
                </label>
                <label>
                  Срок, секунд (пусто — без срока)
                  <input
                    type="number"
                    min={1}
                    value={duration}
                    onChange={(event) => setDuration(event.target.value)}
                  />
                </label>
                <>
                  {action === 'purge' && (
                    <>
                      <label>
                        Количество
                        <input
                          type="number"
                          min={1}
                          max={1000}
                          value={purge.count}
                          onChange={(event) => setPurge({ ...purge, count: Number(event.target.value) })}
                        />
                      </label>
                      <label>
                        ID автора
                        <input
                          value={purge.author}
                          onChange={(event) => setPurge({ ...purge, author: event.target.value })}
                        />
                      </label>
                      <label>
                        Содержит
                        <input
                          value={purge.contains}
                          onChange={(event) => setPurge({ ...purge, contains: event.target.value })}
                        />
                      </label>
                      <label>
                        Тип
                        <select
                          value={purge.type}
                          onChange={(event) => setPurge({ ...purge, type: event.target.value })}
                        >
                          <option value="all">Все</option>
                          <option value="bots">Боты</option>
                          <option value="attachments">Вложения</option>
                        </select>
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={purge.includePinned}
                          onChange={(event) => setPurge({ ...purge, includePinned: event.target.checked })}
                        />
                        Удалять закреплённые
                      </label>
                    </>
                  )}
                  <button className="button primary" disabled={busy}>
                    Подготовить действие
                  </button>
                </>
              </form>
            )}
            {prepared && (
              <div role="alertdialog" aria-label="Подтверждение наказания">
                <h3>Подтвердить дело #{prepared.id}?</h3>
                <p>
                  {actionTitles[prepared.action]} · {prepared.target}
                  <br />
                  {prepared.reason}
                </p>
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/moderation/${prepared.id}/confirm`, 'POST');
                      setPrepared(null);
                      await load();
                    })
                  }
                >
                  Подтвердить
                </button>
                <button
                  className="button"
                  onClick={() =>
                    void run(async () => {
                      await api(`/moderation/${prepared.id}/cancel`, 'POST');
                      setPrepared(null);
                    })
                  }
                >
                  Отмена
                </button>
              </div>
            )}
          </section>
          <section className="module-card">
            <h2>История дел</h2>
            {access.moderationManage && (
              <button
                className="button"
                disabled={busy || !target || !reason}
                onClick={() => {
                  if (
                    window.confirm('Отменить все предупреждения указанного участника с сохранением истории?')
                  )
                    void run(async () => {
                      await api('/moderation/warnings/clear', 'POST', { target, reason });
                      await load();
                    });
                }}
              >
                Отменить все предупреждения
              </button>
            )}
            {rows.map((row) => (
              <button
                key={row.id}
                className="button"
                onClick={() => void run(async () => setDetail(await api(`/moderation/${row.id}`)))}
              >
                #{row.id} · {actionTitles[row.action]} · {row.target} · {row.state}
                {row.revoked ? ' · отменено' : ''}
              </button>
            ))}
            {!rows.length && <p>Нет дел.</p>}
          </section>
          {detail && (
            <section className="module-card">
              <h2>Дело #{detail.case.id}</h2>
              <p>{detail.case.reason}</p>
              <p>
                Исполнитель: {detail.case.actor} · {new Date(detail.case.created_at).toLocaleString()}
              </p>
              <p>{detail.case.error}</p>
              {access.moderationManage && (
                <>
                  <label>
                    Новая причина
                    <input value={reason} onChange={(event) => setReason(event.target.value)} />
                  </label>
                  <button
                    className="button"
                    onClick={() =>
                      void run(async () => {
                        await api(`/moderation/${detail.case.id}`, 'PUT', {
                          reason,
                          revision: detail.case.revision,
                        });
                        setDetail(null);
                        await load();
                      })
                    }
                  >
                    Изменить причину
                  </button>
                  {detail.case.action === 'warn' && (
                    <button
                      className="button"
                      onClick={() =>
                        void run(async () => {
                          await api(`/moderation/${detail.case.id}`, 'PUT', {
                            reason: reason || detail.case.reason,
                            revision: detail.case.revision,
                            revoke: true,
                          });
                          setDetail(null);
                          await load();
                        })
                      }
                    >
                      Отменить предупреждение
                    </button>
                  )}
                  {['ban', 'tempban', 'timeout', 'role-mute'].includes(detail.case.action) &&
                    detail.case.state === 'applied' && (
                      <>
                        <label>
                          Новый срок, секунд
                          <input
                            type="number"
                            min={1}
                            value={duration}
                            onChange={(event) => setDuration(event.target.value)}
                          />
                        </label>
                        <button
                          className="button"
                          onClick={() =>
                            void run(async () => {
                              setPrepared(
                                await api<ModerationCase>(`/moderation/${detail.case.id}/duration`, 'POST', {
                                  duration: duration ? Number(duration) : null,
                                  reason: reason || detail.case.reason,
                                }),
                              );
                              setDetail(null);
                            })
                          }
                        >
                          Подготовить изменение срока
                        </button>
                      </>
                    )}
                  {detail.case.state === 'unknown' &&
                    (['applied', 'failed'] as const).map((state) => (
                      <button
                        className="button"
                        key={state}
                        onClick={() =>
                          void run(async () => {
                            await api(`/moderation/${detail.case.id}/resolve`, 'POST', { state, reason });
                            setDetail(null);
                            await load();
                          })
                        }
                      >
                        После сверки: {state}
                      </button>
                    ))}
                </>
              )}
              <details>
                <summary>История изменений</summary>
                <pre>{JSON.stringify(detail.history, null, 2)}</pre>
              </details>
            </section>
          )}
        </>
      ) : (
        <>
          <section className="module-card">
            <h2>Ручная модерация</h2>
            <ConfigEditor
              schema={
                z.toJSONSchema(moderationConfigSchema, {
                  unrepresentable: 'any',
                  target: 'draft-7',
                }) as JsonSchema
              }
              value={config.document}
              onChange={(document) => setConfig({ ...config, document: document as typeof config.document })}
            />
            <label>
              <input
                type="checkbox"
                checked={config.document.enabled}
                onChange={(event) =>
                  setConfig({ ...config, document: { ...config.document, enabled: event.target.checked } })
                }
              />
              Включена
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.document.notifyDm}
                onChange={(event) =>
                  setConfig({ ...config, document: { ...config.document, notifyDm: event.target.checked } })
                }
              />
              Личное уведомление
            </label>
            <label>
              Ссылка апелляции
              <input
                value={config.document.appealUrl}
                onChange={(event) =>
                  setConfig({ ...config, document: { ...config.document, appealUrl: event.target.value } })
                }
              />
            </label>
            <label>
              Защищённые роли (ID через запятую)
              <input
                value={config.document.protectedRoles.join(',')}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    document: {
                      ...config.document,
                      protectedRoles: event.target.value.split(',').filter(Boolean),
                    },
                  })
                }
              />
            </label>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api('/moderation/settings', 'PUT', config);
                  await load();
                })
              }
            >
              Сохранить модерацию
            </button>
          </section>
          <section className="module-card">
            <h2>Журнал наказаний</h2>
            <label>
              Действия для отправки
              <select
                multiple
                value={logs.document.actions}
                onChange={(event) =>
                  setLogs({
                    ...logs,
                    document: {
                      ...logs.document,
                      actions: Array.from(
                        event.target.selectedOptions,
                        (option) => option.value as ModerationAction,
                      ),
                    },
                  })
                }
              >
                {Object.entries(actionTitles).map(([value, title]) => (
                  <option key={value} value={value}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={logs.document.enabled}
                onChange={(event) =>
                  setLogs({ ...logs, document: { ...logs.document, enabled: event.target.checked } })
                }
              />
              Включён
            </label>
            <label>
              ID канала
              <input
                value={logs.document.channelId || ''}
                onChange={(event) =>
                  setLogs({ ...logs, document: { ...logs.document, channelId: event.target.value || null } })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={logs.document.externalEvents}
                onChange={(event) =>
                  setLogs({ ...logs, document: { ...logs.document, externalEvents: event.target.checked } })
                }
              />
              Внешние действия из Discord Audit Log
            </label>
            <p>
              Переменные:{' '}
              {
                '{{case}}, {{action}}, {{target}}, {{actor}}, {{reason}}, {{duration}}, {{time}}, {{result}}, {{source}}'
              }
              .
            </p>
            <label>
              Шаблон действия
              <select value={action} onChange={(event) => setAction(event.target.value as ModerationAction)}>
                {Object.entries(actionTitles).map(([key, title]) => (
                  <option key={key} value={key}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <BlockEditor
              blocks={
                logs.document.templates[action] || [
                  {
                    id: 'template',
                    type: 'text',
                    content:
                      '## {{action}} · #{{case}}\nКого: {{target}}\nКто: {{actor}}\nКогда: {{time}}\nПочему: {{reason}}\nНасколько: {{duration}}\nРезультат: {{result}}',
                  },
                ]
              }
              onChange={(blocks) =>
                setLogs({
                  ...logs,
                  document: { ...logs.document, templates: { ...logs.document.templates, [action]: blocks } },
                })
              }
            />
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api('/moderation/logs', 'PUT', logs);
                  await load();
                })
              }
            >
              Сохранить журнал
            </button>
          </section>
        </>
      )}
    </div>
  );
}
