import { useEffect, useRef, useState } from 'react';
import {
  AtSign,
  BellOff,
  BookMarked,
  Check,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileJson,
  LoaderCircle,
  Plus,
  Save,
  Send,
  Shield,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import {
  collectionSchema,
  emptyCollection,
  emptyMessage,
  messageProblem,
  type BotMessage,
  type ComposerWorkspace,
  type MessageCollection,
  type SentMessage,
} from '../shared/blocks.js';
import type { GuildInfo } from '../shared/rules.js';
import { api } from './api.js';
import { BlockEditor } from './BlockEditor.js';
import { BlocksPreview } from './BlockPreview.js';

export function Composer({
  guild,
  onError,
  onDirtyChange,
}: {
  guild: GuildInfo;
  onError: (cause: unknown) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [workspace, setWorkspace] = useState<ComposerWorkspace | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [document, setDocument] = useState<MessageCollection>(emptyCollection);
  const [baseline, setBaseline] = useState('');
  const [index, setIndex] = useState(0);
  const [channel, setChannel] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState<'editor' | 'templates' | 'history'>('editor');
  const [preview, setPreview] = useState<'preview' | 'json'>('preview');
  const [editing, setEditing] = useState<SentMessage | null>(null);
  const [confirm, setConfirm] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const dialog = useRef<HTMLDialogElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const dirty = Boolean(baseline && JSON.stringify(document) !== baseline);
  const selected = document.messages[Math.min(index, document.messages.length - 1)];
  const problems = document.messages.map(messageProblem).filter(Boolean);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    let alive = true;
    setLoadError('');
    void api<ComposerWorkspace>('/composer')
      .then((next) => {
        if (alive) {
          setWorkspace(next);
          setDocument(next.draft);
          setBaseline(JSON.stringify(next.draft));
        }
      })
      .catch((cause: unknown) => {
        if (alive) {
          setLoadError(cause instanceof Error ? cause.message : 'Не удалось загрузить редактор');
          onError(cause);
        }
      });
    return () => {
      alive = false;
    };
  }, [loadAttempt]);
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
  }, [confirm]);
  function change(next: MessageCollection) {
    setDocument(next);
    requestId.current = crypto.randomUUID();
  }
  function update(message: BotMessage) {
    change({
      ...document,
      messages: document.messages.map((item) => (item.id === selected.id ? message : item)),
    });
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      await action();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }
  function load(next: MessageCollection) {
    if (dirty && !window.confirm('Заменить несохранённые изменения?')) return;
    change(structuredClone(next));
    setIndex(0);
    setTab('editor');
    setEditing(null);
  }
  async function send() {
    setConfirm(false);
    await run(async () => {
      try {
        const next = editing
          ? await api<ComposerWorkspace>('/messages/' + editing.id, 'PUT', selected)
          : await api<ComposerWorkspace>('/messages/send', 'POST', {
              requestId: requestId.current,
              channelId: channel,
              document,
            });
        setWorkspace(next);
        setStatus(editing ? 'Сообщение обновлено в Discord' : 'Сообщения отправлены в Discord');
        requestId.current = crypto.randomUUID();
        if (editing) {
          setEditing(null);
          setDocument(next.draft);
          setBaseline(JSON.stringify(next.draft));
          setIndex(0);
          setTab('history');
        }
      } catch (cause) {
        setWorkspace(await api<ComposerWorkspace>('/composer'));
        throw cause;
      }
    });
  }
  if (!workspace && loadError)
    return (
      <div className="empty-state" role="alert">
        <h2>Редактор не загрузился</h2>
        <p>{loadError}</p>
        <button className="button" onClick={() => setLoadAttempt((value) => value + 1)}>
          Повторить загрузку
        </button>
      </div>
    );
  if (!workspace)
    return (
      <div className="composer-loading">
        <LoaderCircle size={20} className="spinning" />
        Загрузка редактора сообщений…
      </div>
    );
  return (
    <section className="composer-workspace">
      <div className="composer-toolbar">
        <div className="workspace-tabs" role="tablist" aria-label="Сообщения">
          <button role="tab" aria-selected={tab === 'editor'} onClick={() => setTab('editor')}>
            <Send size={16} />
            Редактор
          </button>
          <button role="tab" aria-selected={tab === 'templates'} onClick={() => setTab('templates')}>
            <BookMarked size={16} />
            Шаблоны <span>{workspace.templates.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
            <Clock size={16} />
            Отправленные
          </button>
        </div>
        <div className="composer-tools">
          <button
            className="icon-button"
            title="Импорт проекта JSON"
            aria-label="Импорт проекта JSON"
            disabled={busy}
            onClick={() => importInput.current?.click()}
          >
            <Upload size={17} />
          </button>
          <input
            ref={importInput}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try {
                load(collectionSchema.parse(JSON.parse(await file.text())));
              } catch {
                onError(new Error('Не удалось импортировать JSON проекта. Проверьте формат файла.'));
              }
              event.target.value = '';
            }}
          />
          <button
            className="icon-button"
            title="Экспорт проекта JSON"
            aria-label="Экспорт проекта JSON"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }),
              );
              const link = window.document.createElement('a');
              link.href = url;
              link.download = 'open-space-message.json';
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download size={17} />
          </button>
        </div>
      </div>
      {status && (
        <div className="composer-status" role="status">
          <Check size={17} />
          {status}
        </div>
      )}
      {tab === 'editor' && (
        <>
          <div className="composer-send-bar">
            <label>
              Канал отправки
              <select
                aria-label="Канал отправки"
                disabled={busy || Boolean(editing)}
                value={editing?.channelId || channel}
                onChange={(event) => {
                  setChannel(event.target.value);
                  requestId.current = crypto.randomUUID();
                }}
              >
                <option value="">Выберите канал</option>
                {guild.channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="composer-actions">
              <button
                className="button"
                disabled={busy || !dirty || Boolean(editing) || Boolean(problems.length)}
                onClick={() =>
                  void run(async () => {
                    const next = await api<ComposerWorkspace>('/composer', 'PUT', {
                      version: workspace.version,
                      document,
                    });
                    setWorkspace(next);
                    setBaseline(JSON.stringify(document));
                    setStatus('Черновик сообщений сохранён');
                  })
                }
              >
                <Save size={16} />
                Сохранить
              </button>
              <button
                className="button primary"
                disabled={busy || (!editing && !channel) || Boolean(problems.length)}
                onClick={() => setConfirm(true)}
              >
                {busy ? <LoaderCircle className="spinning" size={16} /> : <Send size={16} />}
                {editing ? 'Обновить сообщение' : 'Отправить'}
              </button>
            </div>
          </div>
          {editing && (
            <div className="editing-notice">
              Редактируется сообщение из истории. Канал и автор останутся прежними.
              <button
                onClick={() => {
                  setEditing(null);
                  setDocument(workspace.draft);
                  setBaseline(JSON.stringify(workspace.draft));
                  setIndex(0);
                }}
              >
                Отменить редактирование
              </button>
            </div>
          )}
          <div className="workspace-grid composer-grid">
            <section className="editor-panel">
              <fieldset disabled={busy}>
                <div className="message-tabs">
                  {document.messages.map((message, i) => (
                    <div className={i === index ? 'active' : ''} key={message.id}>
                      <button type="button" onClick={() => setIndex(i)}>
                        Сообщение {i + 1}
                      </button>
                      {document.messages.length > 1 && (
                        <button
                          aria-label={'Удалить сообщение ' + (i + 1)}
                          onClick={() => {
                            change({ ...document, messages: document.messages.filter((_, j) => i !== j) });
                            setIndex(Math.max(0, Math.min(index, document.messages.length - 2)));
                          }}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    className="add-message-tab"
                    disabled={document.messages.length >= 10 || Boolean(editing)}
                    title="Добавить сообщение"
                    aria-label="Добавить сообщение"
                    onClick={() => {
                      change({ ...document, messages: [...document.messages, emptyMessage()] });
                      setIndex(document.messages.length);
                    }}
                  >
                    <Plus size={17} />
                  </button>
                </div>
                <BlockEditor
                  blocks={selected.blocks}
                  onChange={(blocks) => update({ ...selected, blocks })}
                />
                <details className="notification-settings" open>
                  <summary>
                    <BellOff size={18} />
                    Настройки уведомлений
                  </summary>
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={selected.silent}
                      onChange={(event) => update({ ...selected, silent: event.target.checked })}
                    />
                    Тихое уведомление
                  </label>
                  <span className="notification-label">Разрешённые упоминания</span>
                  <div className="mentions-options">
                    {(
                      [
                        { key: 'users', label: 'Пользователи (@user)', icon: Users },
                        { key: 'roles', label: 'Роли (@role)', icon: Shield },
                        { key: 'everyone', label: '@everyone / @here', icon: AtSign },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        aria-pressed={selected.mentions[item.key]}
                        onClick={() =>
                          update({
                            ...selected,
                            mentions: { ...selected.mentions, [item.key]: !selected.mentions[item.key] },
                          })
                        }
                      >
                        <item.icon size={19} />
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <small>Включите только те типы упоминаний, которые должны отправлять уведомления.</small>
                </details>
                <button
                  type="button"
                  className="add-message-wide"
                  disabled={document.messages.length >= 10 || Boolean(editing)}
                  onClick={() => {
                    change({ ...document, messages: [...document.messages, emptyMessage()] });
                    setIndex(document.messages.length);
                  }}
                >
                  <Plus size={17} />
                  Добавить сообщение
                </button>
                <div className="template-save">
                  <label>
                    Название шаблона
                    <input
                      value={document.title}
                      maxLength={100}
                      onChange={(event) => change({ ...document, title: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className="button"
                    disabled={Boolean(problems.length)}
                    onClick={() =>
                      void run(async () => {
                        setWorkspace(await api<ComposerWorkspace>('/templates', 'POST', document));
                        setStatus('Шаблон сохранён');
                      })
                    }
                  >
                    <BookMarked size={16} />
                    Сохранить как шаблон
                  </button>
                </div>
              </fieldset>
            </section>
            <aside className="preview-panel">
              <div className="workspace-tabs preview-tabs">
                <button aria-pressed={preview === 'preview'} onClick={() => setPreview('preview')}>
                  Предпросмотр
                </button>
                <button aria-pressed={preview === 'json'} onClick={() => setPreview('json')}>
                  <FileJson size={14} />
                  JSON проекта
                </button>
              </div>
              {preview === 'json' ? (
                <pre className="json-preview">{JSON.stringify(selected, null, 2)}</pre>
              ) : (
                <div className="discord-surface">
                  <div className="discord-author">
                    <span className="bot-avatar">OS</span>
                    <strong>Open Space</strong>
                    <span className="app-tag">APP</span>
                  </div>
                  <BlocksPreview blocks={selected.blocks} />
                </div>
              )}
              {problems.length > 0 && (
                <div className="builder-errors" role="status">
                  {[...new Set(problems)].map((problem) => (
                    <p key={problem}>{problem}</p>
                  ))}
                </div>
              )}
              <p className="preview-note">
                Сообщение {index + 1} из {document.messages.length}. Будет отправлено от имени бота в
                выбранный канал.
              </p>
            </aside>
          </div>
        </>
      )}
      {tab === 'templates' && (
        <div className="library-grid">
          {workspace.templates.length ? (
            workspace.templates.map((template) => (
              <article className="library-card" key={template.id}>
                <BookMarked size={24} />
                <h2>{template.title}</h2>
                <p>{template.document.messages.length} сообщений</p>
                <div>
                  <button className="button" disabled={busy} onClick={() => load(template.document)}>
                    Открыть в редакторе
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label={'Удалить шаблон ' + template.title}
                    onClick={() => {
                      if (window.confirm('Удалить шаблон «' + template.title + '»?'))
                        void run(async () =>
                          setWorkspace(await api<ComposerWorkspace>('/templates/' + template.id, 'DELETE')),
                        );
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state">
              <BookMarked size={30} />
              <h2>Сохраните первый шаблон</h2>
              <p>Создайте сообщение в редакторе и нажмите «Сохранить как шаблон».</p>
            </div>
          )}
        </div>
      )}
      {tab === 'history' && (
        <div className="message-history">
          {workspace.history.length ? (
            workspace.history.map((sent) => (
              <article key={sent.id}>
                <div>
                  <h2>
                    #{guild.channels.find((channel) => channel.id === sent.channelId)?.name || sent.channelId}
                  </h2>
                  <p>
                    {new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' }).format(
                      sent.createdAt,
                    )}{' '}
                    · ID {sent.messageId}
                  </p>
                </div>
                <div>
                  <a
                    className="icon-button"
                    aria-label="Открыть сообщение в Discord"
                    href={`https://discord.com/channels/${guild.id}/${sent.channelId}/${sent.messageId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink size={17} />
                  </a>
                  <button
                    className="button"
                    onClick={() => {
                      if (dirty && !window.confirm('Заменить несохранённые изменения?')) return;
                      setDocument({
                        title: 'Редактирование сообщения',
                        messages: [structuredClone(sent.message)],
                      });
                      setBaseline(
                        JSON.stringify({ title: 'Редактирование сообщения', messages: [sent.message] }),
                      );
                      setEditing(sent);
                      setIndex(0);
                      setTab('editor');
                    }}
                  >
                    Редактировать
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Копировать в новый черновик"
                    onClick={() =>
                      load({
                        title: 'Копия сообщения',
                        messages: [{ ...structuredClone(sent.message), id: crypto.randomUUID() }],
                      })
                    }
                  >
                    <Copy size={17} />
                  </button>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state">
              <Clock size={30} />
              <h2>Отправленных сообщений пока нет</h2>
              <p>После отправки здесь появятся ссылки и кнопки редактирования.</p>
            </div>
          )}
        </div>
      )}
      {confirm && (
        <dialog ref={dialog} className="modal" onCancel={() => setConfirm(false)}>
          <h2>{editing ? 'Обновить сообщение?' : 'Отправить сообщения?'}</h2>
          <p>
            {editing
              ? 'Будет изменено выбранное сообщение бота.'
              : `Бот отправит ${document.messages.length} сообщений в канал #${guild.channels.find((item) => item.id === channel)?.name}.`}
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setConfirm(false)}>
              Отмена
            </button>
            <button className="button primary" onClick={() => void send()}>
              {editing ? 'Обновить' : 'Отправить'}
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
}
