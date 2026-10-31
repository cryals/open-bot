import { useEffect, useState } from 'react';
import { api } from './api.js';
import {
  capabilityNames,
  capabilityTitles,
  type ApplicationSettings as Settings,
  type ApplicationSettingsSnapshot,
} from '../shared/settings.js';
import type { GuildInfo } from '../shared/rules.js';

const intentTitles: Record<keyof Settings['gateway'], string> = {
  messages: 'Сообщения сервера',
  messageContent: 'Содержимое сообщений (привилегированный intent)',
  members: 'Входы и состав участников (привилегированный intent)',
  moderation: 'Баны и журнал модерации',
  reactions: 'Реакции на сообщения',
  autoModeration: 'Конфигурация и срабатывания Native AutoMod',
};
export function ApplicationSettings({ guild }: { guild: GuildInfo }) {
  const [snapshot, setSnapshot] = useState<ApplicationSettingsSnapshot | null>(null),
    [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  async function load() {
    const next = await api<ApplicationSettingsSnapshot>('/settings/application');
    setSnapshot(next);
    setDraft(next.document);
    setDirty(false);
  }
  useEffect(() => {
    void load().catch((error: Error) => setError(error.message));
  }, []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  function change(values: Partial<Settings>) {
    setDraft((value) => value && { ...value, ...values });
    setDirty(true);
    setMessage('');
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  }
  if (!snapshot || !draft)
    return <section className="settings-card">{error || 'Загрузка настроек приложения…'}</section>;
  return (
    <form
      className="settings-card"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await api('/settings/application', 'PUT', { document: draft, version: snapshot.version });
          await load();
          setMessage('Настройки сохранены');
        });
      }}
    >
      <h2>Настройки приложения</h2>
      <p>Хранятся в базе данных. ENV содержит секреты, адреса и параметры запуска.</p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <fieldset disabled={busy}>
        <label>
          Канал технических ошибок
          <select
            value={draft.errorChannelId || ''}
            onChange={(event) => change({ errorChannelId: event.target.value || null })}
          >
            <option value="">Только резервный вебхук / локальный журнал</option>
            {guild.channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </label>
        <h3>События Discord</h3>
        <p className="field-help">
          Изменение intents применяется после перезапуска Bot. Привилегированные intents также нужно разрешить
          в Discord Developer Portal.
        </p>
        {Object.entries(intentTitles).map(([key, title]) => (
          <label key={key} className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.gateway[key as keyof Settings['gateway']]}
              onChange={(event) =>
                change({
                  gateway: {
                    ...draft.gateway,
                    [key]: event.target.checked,
                    ...(key === 'messages' && !event.target.checked ? { messageContent: false } : {}),
                    ...(key === 'messageContent' && event.target.checked ? { messages: true } : {}),
                  },
                })
              }
            />
            {title}
          </label>
        ))}
        {snapshot.restartRequired && <p role="status">Сохранённые intents отличаются от запущенного Bot.</p>}
        <button
          type="button"
          className="button"
          disabled={!snapshot.restartAvailable || dirty}
          onClick={() => {
            if (window.confirm('Перезапустить Bot? Соединение с Discord будет ненадолго прервано.'))
              void run(async () => {
                await api('/settings/restart-bot', 'POST');
                setMessage('Перезапуск запрошен. Обновите состояние через несколько секунд.');
              });
          }}
        >
          Перезапустить Bot
        </button>
        <h3>Внешние серверы</h3>
        <p className="field-help">
          Точные имена хостов, по одному на строку. Схемы, порты и wildcard не допускаются.
        </p>
        {(['gameServerHosts', 'watchdogHosts'] as const).map((field) => (
          <label key={field}>
            {field === 'gameServerHosts'
              ? 'Разрешённые хосты Game Server Status'
              : 'Разрешённые хосты Watchdog'}
            <textarea
              rows={3}
              value={draft[field].join('\n')}
              onChange={(event) => change({ [field]: event.target.value.split('\n') })}
              onBlur={() => change({ [field]: draft[field].map((value) => value.trim()).filter(Boolean) })}
            />
          </label>
        ))}
        <h3>Метрики</h3>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.metricsEnabled}
            disabled={!snapshot.metricsReady && !draft.metricsEnabled}
            onChange={(event) => change({ metricsEnabled: event.target.checked })}
          />
          Экспортёр Prometheus
        </label>
        <p className="field-help">
          Порт: {snapshot.metricsPort}.{' '}
          {snapshot.metricsReady
            ? 'Включение применяется автоматически.'
            : 'Для включения задайте технический секрет METRICS_TOKEN в ENV.'}
        </p>
        <h3>Полномочия модулей</h3>
        <p className="field-help">
          Администраторы имеют все полномочия. Роли Ticket не получают остальные права автоматически.
          Изменения доступа вступают в силу при следующем запросе.
        </p>
        {capabilityNames.map((capability) => (
          <label key={capability}>
            {capabilityTitles[capability]}
            <select
              multiple
              size={Math.min(5, Math.max(2, guild.roles.length))}
              value={draft.grants[capability]}
              onChange={(event) =>
                change({
                  grants: {
                    ...draft.grants,
                    [capability]: Array.from(event.target.selectedOptions, (option) => option.value),
                  },
                })
              }
            >
              {guild.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button type="submit" className="button primary" disabled={!dirty}>
          Сохранить настройки приложения
        </button>
        <button type="button" className="button" onClick={() => void run(load)}>
          Загрузить сохранённые
        </button>
      </fieldset>
    </form>
  );
}
