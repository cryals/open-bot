import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Search } from 'lucide-react';
import type { ActivityEntry, ActivityPage } from '../shared/activity.js';
import { api } from './api.js';

const time = (value: number) =>
  new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'medium' }).format(value);
function Entry({ entry }: { entry: ActivityEntry }) {
  return (
    <details className="activity-entry">
      <summary>
        <span className="activity-kind">{entry.kind}</span>
        <strong>{entry.summary}</strong>
        <span>{entry.actorName}</span>
        <time dateTime={new Date(entry.createdAt).toISOString()}>{time(entry.createdAt)}</time>
      </summary>
      <div className="activity-detail">
        <p>
          <strong>Автор:</strong> {entry.actorName} · <code>{entry.actor}</code>
        </p>
        <p>
          <strong>Объект:</strong> <code>{entry.target}</code> · Запись #{entry.id}
        </p>
        {entry.diff && (
          <div className="activity-diff" aria-label="Разница по строкам">
            {entry.diff.split('\n').map((line, index) => (
              <div key={index} className={line.startsWith('+') ? 'diff-added' : 'diff-removed'}>
                {line || ' '}
              </div>
            ))}
          </div>
        )}
        {(entry.before !== null || entry.after !== null) && (
          <div className="activity-comparison">
            {entry.before !== null && (
              <div>
                <h3>До изменения</h3>
                <pre>{entry.before}</pre>
              </div>
            )}
            {entry.after !== null && (
              <div>
                <h3>После изменения</h3>
                <pre>{entry.after}</pre>
              </div>
            )}
          </div>
        )}
        {Object.keys(entry.details).length > 0 && (
          <details>
            <summary>Подробности события</summary>
            <pre>{JSON.stringify(entry.details, null, 2)}</pre>
          </details>
        )}
      </div>
    </details>
  );
}
export function ActivityView() {
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(true);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 350);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let alive = true;
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const next = await api<ActivityPage>('/activity?search=' + encodeURIComponent(query));
        if (alive) {
          setPage(next);
          setError('');
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить журнал');
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      if (liveRef.current) void load();
    }, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [query, attempt]);
  async function older() {
    if (busy || !page?.entries.length) return;
    setBusy(true);
    try {
      const next = await api<ActivityPage>(
        '/activity?search=' + encodeURIComponent(query) + '&before=' + page.entries.at(-1)!.id,
      );
      setPage({ ...next, entries: [...page.entries, ...next.entries] });
      setLive(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить записи');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="activity-panel">
      <div className="activity-toolbar">
        <label className="activity-search">
          <Search size={17} />
          <input
            aria-label="Поиск в журнале"
            placeholder="Событие, автор, ID или объект…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={200}
          />
        </label>
        <button className="button" onClick={() => setAttempt((value) => value + 1)}>
          <RefreshCw size={16} />
          Обновить
        </button>
        <a className="button" href="/api/activity/export" download>
          <Download size={16} />
          Скачать JSONL
        </a>
      </div>
      <div className="activity-status">
        <label className="checkbox">
          <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
          Автообновление
        </label>
        <span>
          {page ? `${page.entries.length} записей · в очереди Discord: ${page.pending}` : 'Загрузка журнала…'}
        </span>
      </div>
      {(error || page?.deliveryError || page?.fileError) && (
        <div className="alert error" role="alert">
          {error || page?.deliveryError || page?.fileError}
        </div>
      )}
      <p className="field-help">
        События ui.* фиксируют действия в браузере. Сохранения, публикации и отправки дополнительно
        подтверждаются сервером. Откройте запись, чтобы увидеть полную разницу.
      </p>
      <div className="activity-list">
        {page?.entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
      </div>
      {page?.entries.length === 0 && (
        <div className="empty-state">
          <h2>Записи не найдены</h2>
          <p>Попробуйте изменить поисковый запрос.</p>
        </div>
      )}
      {page && page.entries.length >= 100 && (
        <button className="button" disabled={busy} onClick={() => void older()}>
          Загрузить более ранние записи
        </button>
      )}
    </section>
  );
}
