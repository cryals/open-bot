import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { ConfigEditor, type JsonSchema } from './ConfigEditor.js';
import type { GuildInfo } from '../shared/rules.js';
import type { Access } from '../shared/modules.js';
import { giveawaySchema } from '../shared/community.js';
import { z } from 'zod';
type Definition = { id: string; title: string; capability: string; intents: string[] };
type Config = {
  document: unknown;
  version: number;
  schema: JsonSchema;
  requiredIntents: string[];
  missingPermissions: string[];
  appliedGateway: Record<string, boolean> | null;
};
type RecordData = Record<string, unknown>;
export function Community({ access }: { access: Access }) {
  const loadEpoch = useRef(0);
  const [definitions, setDefinitions] = useState<Definition[]>([]),
    [selected, setSelected] = useState(''),
    [config, setConfig] = useState<Config | null>(null),
    [draft, setDraft] = useState<unknown>(null),
    [guild, setGuild] = useState<GuildInfo | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [records, setRecords] = useState<RecordData[]>([]),
    [restores, setRestores] = useState<RecordData[]>([]),
    [jobs, setJobs] = useState<RecordData[]>([]),
    [detail, setDetail] = useState<unknown>(null),
    [restoreSections, setRestoreSections] = useState(['roles', 'channels', 'messages']),
    [newGiveaway, setNewGiveaway] = useState<unknown>({
      prize: '',
      image: null,
      channelId: '',
      startsAt: Date.now(),
      endsAt: Date.now() + 3600000,
      winners: 1,
      requiredRoles: [],
      blockedRoles: [],
      minAccountDays: 0,
      dailyBonus: 0,
      referralBonus: 0,
      maxChances: 1,
      rewardRole: null,
      notifyDm: false,
    }),
    [credentials, setCredentials] = useState({
      provider: 'twitch',
      account: 'default',
      accessToken: '',
      refreshToken: '',
    });
  const dirty = !!config && JSON.stringify(config.document) !== JSON.stringify(draft);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  }
  async function load(id: string) {
    const epoch = ++loadEpoch.current;
    setSelected(id);
    setConfig(null);
    setDetail(null);
    setRecords([]);
    const saved = await api<Config>('/community/config/' + id);
    const jobs = await api<RecordData[]>('/community/jobs');
    let records: RecordData[] = [],
      restores: RecordData[] = [];
    if (id === 'guild-backup') {
      const data = await api<{ backups: RecordData[]; restores: RecordData[] }>('/community/backups');
      records = data.backups;
      restores = data.restores;
    } else if (id === 'giveaways') records = await api('/community/giveaways');
    else if (id === 'forms') records = await api('/community/forms');
    else if (id === 'automod') records = await api('/community/evidence');
    else if (id === 'subscriptions') {
      const data = await api<{ sources: RecordData[]; delivery: RecordData[] }>('/community/feeds');
      records = [...data.sources, ...data.delivery];
    } else records = await api('/community/state/' + id);
    if (epoch !== loadEpoch.current) return;
    setConfig(saved);
    setDraft(saved.document);
    setJobs(jobs);
    setRecords(records);
    setRestores(restores);
  }
  useEffect(() => {
    void run(async () => {
      const items = await api<Definition[]>('/community');
      const guild = items.length ? await api<GuildInfo>('/community/guild') : null;
      setDefinitions(items);
      setGuild(guild);
      if (items.length) await load(items[0].id);
      else if (access.formsView || access.formReviewer) {
        setSelected('forms-read');
        setRecords(await api('/community/forms'));
      }
    });
  }, []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const act = (path: string, body: unknown = {}) =>
    void run(async () => {
      await api(path, 'POST', body);
      setMessage('Действие принято.');
      await load(selected);
    });
  return (
    <div className="module-workspace">
      {!access.admin && <h1>Модули сообщества</h1>}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <nav className="module-toolbar" aria-label="Модули">
        {definitions.map((item) => (
          <button
            key={item.id}
            className={'button' + (selected === item.id ? ' primary' : '')}
            onClick={() => {
              if (!dirty || window.confirm('Перейти без сохранения?')) void run(() => load(item.id));
            }}
          >
            {item.title}
          </button>
        ))}
      </nav>
      {config && (
        <>
          {!!config.missingPermissions?.length && (
            <p role="alert">
              У бота нет базовых прав: {config.missingPermissions.join(', ')}. Права отдельных действий также
              проверяются перед выполнением.
            </p>
          )}
          <p>
            Требуемые события: {config.requiredIntents.join(', ') || 'нет дополнительных'}.{' '}
            {config.requiredIntents.some((intent) => !config.appliedGateway?.[intent])
              ? 'Некоторые события не включены. Настройте их в разделе «Настройки» и перезапустите Bot.'
              : ''}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api('/community/config/' + selected, 'PUT', {
                  document: draft,
                  version: config.version,
                });
                await load(selected);
                setMessage('Настройки сохранены');
              });
            }}
          >
            <fieldset disabled={busy}>
              <ConfigEditor schema={config.schema} value={draft} onChange={setDraft} guild={guild} />
              <div className="module-toolbar">
                <button className="button primary" disabled={!dirty}>
                  Сохранить
                </button>
                <button type="button" className="button" onClick={() => void run(() => load(selected))}>
                  Обновить
                </button>
              </div>
            </fieldset>
          </form>
        </>
      )}
      {selected === 'automod' && (
        <button className="button" disabled={busy} onClick={() => act('/community/automod/sync')}>
          Синхронизировать Native AutoMod
        </button>
      )}
      {selected === 'role-menus' &&
        ((draft as { panels?: { id: string; title: string }[] })?.panels || []).map((panel) => (
          <div className="module-toolbar" key={panel.id}>
            <span>{panel.title}</span>
            <button
              className="button"
              disabled={busy || dirty}
              onClick={() => act('/community/roles/' + panel.id + '/publish')}
            >
              Опубликовать
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => act('/community/roles/' + panel.id + '/disable')}
            >
              Отключить опубликованную панель
            </button>
          </div>
        ))}
      {selected === 'anti-raid' && (
        <div className="module-toolbar">
          {['start', 'stop'].map((action) => (
            <button
              className="button"
              key={action}
              onClick={() => {
                const reason = window.prompt('Причина');
                if (reason) act('/community/raid/' + action, { reason });
              }}
            >
              {action === 'start' ? 'Включить защитный режим' : 'Выключить защитный режим'}
            </button>
          ))}
        </div>
      )}
      {selected === 'giveaways' && (
        <details className="module-card">
          <summary>Новый розыгрыш</summary>
          <ConfigEditor
            schema={
              z.toJSONSchema(giveawaySchema, { unrepresentable: 'any', target: 'draft-7' }) as JsonSchema
            }
            value={newGiveaway}
            onChange={setNewGiveaway}
            guild={guild}
          />
          <button className="button primary" onClick={() => act('/community/giveaways', newGiveaway)}>
            Создать розыгрыш
          </button>
        </details>
      )}
      {selected === 'subscriptions' && (
        <section className="module-card">
          <h2>Подключения сервисов</h2>
          <p>
            OAuth: укажите callback /auth/integrations/ПЛАТФОРМА/callback в приложении провайдера. API-секреты
            приложения и INTEGRATION_KEY задаются в техническом ENV.
          </p>
          <label>
            Платформа
            <select
              value={credentials.provider}
              onChange={(event) => setCredentials({ ...credentials, provider: event.target.value })}
            >
              {['twitch', 'kick', 'tiktok', 'reddit', 'vk'].map((provider) => (
                <option key={provider}>{provider}</option>
              ))}
            </select>
          </label>
          <a className="button" href={'/auth/integrations/' + credentials.provider}>
            Подключить через OAuth
          </a>
          <details>
            <summary>Подключить существующий токен</summary>
            <label>
              Аккаунт (default или TikTok open_id)
              <input
                value={credentials.account}
                onChange={(event) => setCredentials({ ...credentials, account: event.target.value })}
              />
            </label>
            <label>
              Access token
              <input
                name="accessToken"
                type="password"
                autoComplete="off"
                value={credentials.accessToken}
                onChange={(event) => setCredentials({ ...credentials, accessToken: event.target.value })}
              />
            </label>
            <label>
              Refresh token
              <input
                name="refreshToken"
                type="password"
                autoComplete="off"
                value={credentials.refreshToken}
                onChange={(event) => setCredentials({ ...credentials, refreshToken: event.target.value })}
              />
            </label>
            <button
              className="button"
              onClick={() =>
                void run(async () => {
                  await api('/community/integrations/' + credentials.provider, 'PUT', credentials);
                  setCredentials({ ...credentials, accessToken: '', refreshToken: '' });
                  setMessage('Подключение сохранено');
                })
              }
            >
              Сохранить токен
            </button>
            <button
              className="button danger"
              onClick={() =>
                void run(async () => {
                  await api(
                    '/community/integrations/' +
                      credentials.provider +
                      '/' +
                      encodeURIComponent(credentials.account),
                    'DELETE',
                  );
                  setMessage('Подключение удалено');
                })
              }
            >
              Отключить аккаунт
            </button>
          </details>
          <p>
            YouTube: YOUTUBE_API_KEY в техническом ENV. TikTok доступен только для авторизованного creator.
            Классификация Shorts официальным Data API не гарантируется.
          </p>
        </section>
      )}
      {selected === 'guild-backup' && (
        <section className="module-card">
          <h2>Снимки сервера</h2>
          <fieldset>
            <legend>Разделы плана восстановления</legend>
            {Object.entries({
              roles: 'Роли',
              channels: 'Каналы и ветки',
              messages: 'Последние сообщения',
              members: 'Назначения ролей',
              settings: 'Настройки сервера',
              extras: 'Дополнительные ресурсы',
            }).map(([key, title]) => (
              <label key={key} className="checkbox">
                <input
                  type="checkbox"
                  checked={restoreSections.includes(key)}
                  onChange={(event) =>
                    setRestoreSections(
                      event.target.checked
                        ? [...restoreSections, key]
                        : restoreSections.filter((value) => value !== key),
                    )
                  }
                />
                {title}
              </label>
            ))}
          </fieldset>
          <p>
            Сохраняются три последние завершённые копии. Восстановление создаёт сообщения от Open Bot с
            подписью исходного автора.
          </p>
          <button className="button primary" disabled={busy} onClick={() => act('/community/backups')}>
            Создать копию сейчас
          </button>
          <label>
            Импорт .json.gz
            <input
              type="file"
              accept=".gz"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 100 * 1024 * 1024) {
                  setError('Файл больше 100 МБ');
                  return;
                }
                void run(async () => {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  let binary = '';
                  for (let i = 0; i < bytes.length; i += 8192)
                    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                  await api('/community/backups/import', 'POST', { data: btoa(binary) });
                  await load(selected);
                });
              }}
            />
          </label>
        </section>
      )}
      <section className="module-card">
        <h2>{selected.startsWith('forms') ? 'Заявки' : 'Состояние и история'}</h2>
        {records.length === 0 ? (
          <p>Нет записей.</p>
        ) : (
          records.map((record, index) => (
            <article className="module-card" key={String(record.id || record.key || index)}>
              <strong>
                {String(record.id || record.key || record.source || record.feed_id || index + 1)}
              </strong>{' '}
              · {String(record.state || record.action || '')}
              {selected === 'guild-backup' && record.state === 'ready' && (
                <div className="module-toolbar">
                  <a className="button" href={'/api/community/backups/' + record.id + '/download'}>
                    Скачать
                  </a>
                  <button
                    className="button"
                    onClick={() =>
                      void run(async () => {
                        const result = await api<RecordData>(
                          '/community/backups/' + record.id + '/restore',
                          'POST',
                          { sections: restoreSections, mode: 'add' },
                        );
                        setDetail(result);
                        await load(selected);
                        setDetail(result);
                      })
                    }
                  >
                    План восстановления
                  </button>
                  <button
                    className="button danger"
                    onClick={() => {
                      const value = window.prompt(
                        'Режим замены удалит исходные каналы и роли после создания новых. Введите REPLACE и ID сервера',
                      );
                      if (value)
                        void run(async () => {
                          const result = await api('/community/backups/' + record.id + '/restore', 'POST', {
                            sections: restoreSections,
                            mode: 'replace',
                            replaceConfirmation: value,
                          });
                          await load(selected);
                          setDetail(result);
                        });
                    }}
                  >
                    План замены
                  </button>
                </div>
              )}
              {selected === 'giveaways' && (
                <div className="module-toolbar">
                  {['end', 'cancel', 'reroll'].map((action) => (
                    <button
                      className="button"
                      key={action}
                      onClick={() => {
                        const reason = window.prompt('Причина ' + action);
                        if (reason) act('/community/giveaways/' + record.id + '/' + action, { reason });
                      }}
                    >
                      {action}
                    </button>
                  ))}
                </div>
              )}
              {selected === 'automod' && Boolean(record.case_id) && access.moderationManage && (
                <button
                  className="button"
                  onClick={() => {
                    const reason = window.prompt('Причина отмены решения AutoMod');
                    if (reason)
                      void run(async () => {
                        const result = await api<{ id: number; state: string }>(
                          '/community/evidence/' + record.id + '/undo',
                          'POST',
                          { reason },
                        );
                        if (
                          result.state === 'prepared' &&
                          window.confirm('Подтвердить снятие именно этой санкции?')
                        )
                          await api('/moderation/' + result.id + '/confirm', 'POST');
                        await load(selected);
                      });
                  }}
                >
                  Отменить санкцию
                </button>
              )}
              {selected.startsWith('forms') && (
                <div className="module-toolbar">
                  <button
                    className="button"
                    onClick={() =>
                      void run(async () => setDetail(await api('/community/forms/' + record.id)))
                    }
                  >
                    Открыть заявку
                  </button>
                  {(access.formsManage || Boolean(record.canProcess)) &&
                    ['processing', 'accepted', 'rejected'].map((state) => (
                      <button
                        className="button"
                        key={state}
                        onClick={() => {
                          const comment = window.prompt('Комментарий решения');
                          if (comment !== null)
                            act('/community/forms/' + record.id + '/review', { state, comment });
                        }}
                      >
                        {state}
                      </button>
                    ))}
                </div>
              )}
              {selected === 'subscriptions' && record.state === 'unknown' && (
                <button
                  className="button"
                  onClick={() => {
                    const id = window.prompt(
                      'ID отправленного сообщения. Пусто — после сверки разрешить повтор',
                    );
                    if (id !== null)
                      act('/community/feeds/resolve', {
                        feed: record.feed_id,
                        content: record.content_id,
                        messageId: id || null,
                      });
                  }}
                >
                  Сверить доставку
                </button>
              )}
              <details>
                <summary>Детали</summary>
                <pre>{JSON.stringify(record, null, 2)}</pre>
              </details>
            </article>
          ))
        )}
      </section>
      {selected === 'guild-backup' &&
        restores.map((row) => (
          <section className="module-card" key={String(row.id)}>
            <h3>Восстановление {String(row.id)}</h3>
            <p>
              {String(row.state)} · {String(row.error || '')}
            </p>
            <div className="module-toolbar">
              <button
                className="button"
                onClick={() => void run(async () => setDetail(await api('/community/restores/' + row.id)))}
              >
                План и шаги
              </button>
              {['confirm', 'resume', 'cancel'].map((action) => (
                <button
                  className="button"
                  key={action}
                  onClick={() => {
                    if (action !== 'confirm' || window.confirm('Выполнить именно этот план восстановления?'))
                      act('/community/restores/' + row.id + '/' + action);
                  }}
                >
                  {action}
                </button>
              ))}
            </div>
          </section>
        ))}
      {detail !== null && (
        <section className="module-card">
          <h2>Подробности</h2>
          {selected === 'guild-backup' &&
            Array.isArray((detail as { steps?: unknown[] })?.steps) &&
            (detail as { steps: RecordData[]; restore: RecordData }).steps
              .filter((step) => ['running', 'unknown'].includes(String(step.state)))
              .map((step) => (
                <button
                  className="button"
                  key={String(step.kind) + String(step.source_id)}
                  onClick={() => {
                    const newId = window.prompt(
                      `Сверьте ${step.kind}:${step.source_id}. ID созданного объекта; пусто — подтверждаю, что он не создан`,
                    );
                    if (newId !== null)
                      act(
                        '/community/restores/' + (detail as { restore: RecordData }).restore.id + '/resolve',
                        { kind: step.kind, source: step.source_id, newId: newId || null },
                      );
                  }}
                >
                  Сверить шаг {String(step.kind)}:{String(step.source_id)}
                </button>
              ))}
          <pre>{JSON.stringify(detail, null, 2)}</pre>
        </section>
      )}
      <details className="module-card">
        <summary>Задания и ошибки</summary>
        <pre>{JSON.stringify(jobs, null, 2)}</pre>
      </details>
    </div>
  );
}
