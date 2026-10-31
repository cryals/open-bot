import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { Access, TicketConfig, TicketRow, TicketCategory } from '../shared/modules.js';
import { BlockEditor } from './BlockEditor.js';
import { BlocksPreview } from './BlockPreview.js';
import MarkdownContent from './MarkdownContent.js';
type Guild = {
  channels: { id: string; name: string; type: number }[];
  roles: { id: string; name: string }[];
};
type FileRecord = {
  id: string;
  name: string;
  state: string;
  error: string | null;
  size: number;
  mime: string;
};
type Message = {
  id: string;
  author_name: string;
  author_id: string;
  content: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  revisions: { id: number; content: string; kind: string; changed_at: number }[];
  files: FileRecord[];
};
type Detail = {
  ticket: TicketRow;
  canViewStaff: boolean;
  events: { id: number; kind: string; actor: string; detail: string; created_at: number }[];
  jobs: { id: number; action: string; value: string; error: string | null; state: string }[];
};
type Settings = {
  document: TicketConfig;
  version: number;
  gatewayEnabled: boolean;
  panels: {
    id: string;
    channel_id: string;
    message_id: string | null;
    state: string;
    error: string | null;
  }[];
};
const date = (value: number) => new Date(value).toLocaleString('ru');
const labels: Record<string, string> = {
  creating: 'Создаётся',
  open: 'Открыт',
  claimed: 'В работе',
  waiting: 'Ожидает ответа',
  closing: 'Архивируется',
  closed: 'Закрыт',
  purging: 'Удаляется',
};
export function Tickets({ access, active = true }: { access: Access; active?: boolean }) {
  const [tab, setTab] = useState<'list' | 'settings'>('list'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [tickets, setTickets] = useState<TicketRow[]>([]),
    [nextBefore, setNextBefore] = useState<number | null>(null),
    [search, setSearch] = useState(''),
    [state, setState] = useState(''),
    [author, setAuthor] = useState(''),
    [assignee, setAssignee] = useState(''),
    [category, setCategory] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null),
    [scope, setScope] = useState<'customer' | 'staff' | 'events'>('customer'),
    [messages, setMessages] = useState<Message[]>([]),
    [value, setValue] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null),
    [guild, setGuild] = useState<Guild | null>(null),
    [categoryIndex, setCategoryIndex] = useState(0),
    [channel, setChannel] = useState(''),
    [saved, setSaved] = useState('');
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
  async function list(before?: number) {
    const query = new URLSearchParams(
      Object.entries({
        search,
        state,
        author,
        assignee,
        category,
        ...(before ? { before: String(before) } : {}),
      }).filter(([, value]) => value),
    );
    const result = await api<{ tickets: TicketRow[]; nextBefore: number | null }>('/tickets?' + query);
    setTickets((previous) => (before ? [...previous, ...result.tickets] : result.tickets));
    setNextBefore(result.nextBefore);
  }
  async function open(id: number) {
    const next = await api<Detail>('/tickets/' + id);
    setDetail(next);
    setScope('customer');
    const result = await api<{ messages: Message[] }>('/tickets/' + id + '/messages');
    setMessages(result.messages);
  }
  async function transcript(next: 'customer' | 'staff' | 'events', older = false) {
    if (!detail) return;
    setScope(next);
    if (next === 'events') return;
    const before = older ? messages.at(-1)?.id : undefined;
    const result = await api<{ messages: Message[] }>(
      `/tickets/${detail.ticket.id}/messages?scope=${next}${before ? '&before=' + before : ''}`,
    );
    setMessages((previous) => (older ? [...previous, ...result.messages] : result.messages));
  }
  useEffect(() => {
    if (!active) return;
    void run(async () => {
      await list();
      if (access.ticketManage && !settings) {
        const [loaded, info] = await Promise.all([
          api<Settings>('/tickets/settings'),
          api<Guild>('/tickets/guild'),
        ]);
        setSettings(loaded);
        setSaved(JSON.stringify(loaded.document));
        setGuild(info);
      }
    });
  }, [active]);
  useEffect(() => {
    if (!active || tab !== 'list') return;
    const timer = setInterval(() => {
      if (!document.hidden && !busy) void list().catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [active, tab, busy, search, state, author, assignee, category]);
  const dirty = Boolean(settings && saved !== JSON.stringify(settings.document));
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const selected = settings?.document.categories[categoryIndex];
  function patch(values: Partial<TicketConfig>) {
    setSettings((previous) => previous && { ...previous, document: { ...previous.document, ...values } });
  }
  function patchCategory(values: Partial<TicketCategory>) {
    if (!settings || !selected) return;
    patch({
      categories: settings.document.categories.map((category, index) =>
        index === categoryIndex ? { ...category, ...values } : category,
      ),
    });
  }
  async function action(action: string) {
    if (!detail) return;
    if (
      action === 'close' &&
      !window.confirm(
        'Сохранить архив и закрыть тикет #' + detail.ticket.id + '? Канал будет удалён после сохранения.',
      )
    )
      return;
    await api('/tickets/' + detail.ticket.id + '/action', 'POST', {
      action,
      value,
      confirmed: action === 'close',
    });
    await open(detail.ticket.id);
    await list();
  }
  return (
    <div className="module-workspace">
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="module-toolbar">
        <button className="button" onClick={() => setTab('list')}>
          Обращения
        </button>
        {access.ticketManage && (
          <button className="button" onClick={() => setTab('settings')}>
            Панели и категории
          </button>
        )}
        <button className="button" disabled={busy} onClick={() => void run(() => list())}>
          Обновить
        </button>
      </div>
      {tab === 'list' && (
        <>
          <form
            className="module-filters"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => list());
            }}
          >
            <label>
              Поиск
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Номер, автор или причина"
              />
            </label>
            <label>
              Статус
              <select value={state} onChange={(event) => setState(event.target.value)}>
                <option value="">Все</option>
                {Object.entries(labels).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              ID автора
              <input value={author} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <label>
              ID ответственного
              <input value={assignee} onChange={(event) => setAssignee(event.target.value)} />
            </label>
            <label>
              Категория
              <input
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="ID категории"
              />
            </label>
            <button className="button" disabled={busy}>
              Найти
            </button>
          </form>
          <div className="ticket-columns">
            <section className="module-card ticket-list" aria-label="Список обращений">
              {tickets.length ? (
                tickets.map((ticket) => (
                  <button
                    key={ticket.id}
                    className={'ticket-row ' + (detail?.ticket.id === ticket.id ? 'selected' : '')}
                    onClick={() => void run(() => open(ticket.id))}
                  >
                    <strong>
                      #{ticket.id} · {labels[ticket.state] || ticket.state}
                    </strong>
                    <span>
                      {ticket.category_id} · {ticket.author_id}
                    </span>
                    <small>
                      {date(ticket.created_at)}
                      {ticket.error ? ' · Требуется внимание' : ''}
                    </small>
                  </button>
                ))
              ) : (
                <p>Обращений пока нет.</p>
              )}
              {nextBefore && (
                <button className="button" onClick={() => void run(() => list(nextBefore))}>
                  Ещё обращения
                </button>
              )}
            </section>
            <section data-no-audit className="module-card transcript" aria-label="Транскрипт тикета">
              {detail ? (
                <>
                  <h2>
                    Тикет #{detail.ticket.id} · {labels[detail.ticket.state] || detail.ticket.state}
                  </h2>
                  <p>
                    Автор: {detail.ticket.author_id} · Ответственный:{' '}
                    {detail.ticket.assignee || 'не назначен'}
                  </p>
                  {detail.ticket.reason && <p>Причина закрытия: {detail.ticket.reason}</p>}
                  {detail.ticket.error && <p className="error-banner">{detail.ticket.error}</p>}
                  {detail.ticket.archive_gap && <p className="module-note">{detail.ticket.archive_gap}</p>}
                  {detail.jobs?.map((job) => (
                    <p className="module-note" key={job.id}>
                      Изменение {job.action}: {job.value} · {job.state}
                      {job.error ? ' · ' + job.error : ''}{' '}
                      <button
                        className="button"
                        disabled={busy || job.state === 'running'}
                        onClick={() =>
                          void run(async () => {
                            await api(`/tickets/${detail.ticket.id}/jobs/${job.id}`, 'DELETE');
                            await open(detail.ticket.id);
                          })
                        }
                      >
                        Отменить задание
                      </button>
                    </p>
                  ))}
                  {access.ticketManage && ['open', 'claimed', 'waiting'].includes(detail.ticket.state) && (
                    <div className="module-card">
                      <label>
                        Причина / ID участника / ID категории
                        <input
                          value={value}
                          onChange={(event) => setValue(event.target.value)}
                          maxLength={1000}
                        />
                      </label>
                      <div className="module-toolbar">
                        {[
                          ['claim', 'Взять'],
                          ['waiting', 'Ожидание'],
                          ['add', 'Добавить участника'],
                          ['remove', 'Убрать участника'],
                          ['category', 'Сменить категорию'],
                          ['close', 'Закрыть'],
                        ].map(([id, label]) => (
                          <button
                            key={id}
                            className="button"
                            disabled={busy}
                            onClick={() => void run(() => action(id))}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="module-toolbar">
                    <button className="button" onClick={() => void run(() => transcript('customer'))}>
                      Переписка
                    </button>
                    {detail.canViewStaff && (
                      <button className="button" onClick={() => void run(() => transcript('staff'))}>
                        Обсуждение команды
                      </button>
                    )}
                    <button className="button" onClick={() => setScope('events')}>
                      События
                    </button>
                    <button className="button" onClick={() => void run(() => open(detail.ticket.id))}>
                      Обновить тикет
                    </button>
                  </div>
                  {scope === 'events' ? (
                    detail.events.map((event) => (
                      <p key={event.id}>
                        <small>
                          {date(event.created_at)} · {event.actor}
                        </small>
                        <br />
                        {event.kind} · {event.detail}
                      </p>
                    ))
                  ) : (
                    <>
                      {[...messages].reverse().map((message) => (
                        <article
                          className={'ticket-message ' + (message.deleted_at ? 'deleted' : '')}
                          key={message.id}
                        >
                          <header>
                            <strong>{message.author_name}</strong>
                            <time>{date(message.created_at)}</time>
                          </header>
                          {message.deleted_at && <small>Удалено {date(message.deleted_at)}</small>}
                          {message.edited_at && <small>Изменено {date(message.edited_at)}</small>}
                          <MarkdownContent>{message.content}</MarkdownContent>
                          {message.files.map((file) => (
                            <p key={file.id}>
                              {file.state === 'stored' && file.mime.startsWith('image/') && (
                                <img
                                  className="transcript-image"
                                  loading="lazy"
                                  alt={file.name}
                                  src={'/api/tickets/files/' + file.id + '?preview=1'}
                                />
                              )}
                              {file.state === 'stored' ? (
                                <a href={'/api/tickets/files/' + file.id} download>
                                  {file.name} · {Math.round(file.size / 1024)} КБ
                                </a>
                              ) : (
                                <span>
                                  {file.name}: {file.error || 'копируется'}
                                </span>
                              )}
                            </p>
                          ))}
                          {message.revisions.length > 0 && (
                            <details>
                              <summary>История изменений ({message.revisions.length})</summary>
                              {message.revisions.map((revision) => (
                                <div key={revision.id}>
                                  <small>
                                    {date(revision.changed_at)} · {revision.kind}
                                  </small>
                                  <pre>{revision.content}</pre>
                                </div>
                              ))}
                            </details>
                          )}
                        </article>
                      ))}
                      {messages.length >= 100 && (
                        <button
                          className="button"
                          onClick={() => void run(() => transcript(scope as 'customer' | 'staff', true))}
                        >
                          Загрузить старые сообщения
                        </button>
                      )}
                    </>
                  )}
                </>
              ) : (
                <p>Выберите обращение, чтобы открыть транскрипт.</p>
              )}
            </section>
          </div>
        </>
      )}
      {tab === 'settings' && settings && guild && access.ticketManage && (
        <>
          <section className="module-card">
            <h2>Доступ и хранение</h2>
            <p>
              Служебный текстовый канал должен быть закрыт для @everyone. Ролям Ticket нельзя выдавать
              Administrator или Manage Threads.
            </p>
            {!settings.gatewayEnabled && (
              <p className="module-note">
                Включите события сообщений в настройках приложения и Message Content Intent в Developer
                Portal.
              </p>
            )}
            <div className="module-grid">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={settings.document.enabled}
                  onChange={(event) => patch({ enabled: event.target.checked })}
                />
                Принимать обращения
              </label>
              <label>
                Полная роль Ticket
                <select
                  value={settings.document.fullRoleId}
                  onChange={(event) => patch({ fullRoleId: event.target.value })}
                >
                  {guild.roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Роль просмотра
                <select
                  value={settings.document.viewRoleId}
                  onChange={(event) => patch({ viewRoleId: event.target.value })}
                >
                  {guild.roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Закрытый служебный канал
                <select
                  value={settings.document.staffChannelId || ''}
                  onChange={(event) => patch({ staffChannelId: event.target.value || null })}
                >
                  <option value="">Выберите канал</option>
                  {guild.channels
                    .filter((channel) => channel.type === 0)
                    .map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        #{channel.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Лимит вложения, МБ
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={settings.document.maxAttachmentMb}
                  onChange={(event) => patch({ maxAttachmentMb: Number(event.target.value) })}
                />
              </label>
              <label>
                Лимит архива, МБ
                <input
                  type="number"
                  min={100}
                  max={100000}
                  value={settings.document.maxArchiveMb}
                  onChange={(event) => patch({ maxArchiveMb: Number(event.target.value) })}
                />
              </label>
            </div>
            <p>
              Архив закрытого обращения хранится 180 дней. Затем удаляются его файлы, переписка и служебная
              ветка.
            </p>
          </section>
          <section className="module-card">
            <h2>Категории</h2>
            <div className="module-toolbar">
              {settings.document.categories.map((category, index) => (
                <button className="button" key={category.id} onClick={() => setCategoryIndex(index)}>
                  {category.name}
                </button>
              ))}
              <button
                className="button"
                disabled={settings.document.categories.length >= 25}
                onClick={() => {
                  const next: TicketCategory = {
                    id: 'cat-' + crypto.randomUUID().slice(0, 8),
                    name: 'Новая категория',
                    description: '',
                    emoji: '',
                    channelName: 'ticket-{id}',
                    enabled: false,
                    parentId: guild.channels.find((channel) => channel.type === 4)?.id || '',
                    supportRoles: [],
                    mentionRole: null,
                    intro: [
                      {
                        id: crypto.randomUUID(),
                        type: 'text',
                        content: 'Опишите вашу ситуацию. Поддержка ответит в этом канале.',
                      },
                    ],
                    questions: [],
                  };
                  patch({ categories: [...settings.document.categories, next] });
                  setCategoryIndex(settings.document.categories.length);
                }}
              >
                Добавить категорию
              </button>
            </div>
            {selected && (
              <>
                <div className="module-grid">
                  <label>
                    Название
                    <input
                      value={selected.name}
                      onChange={(event) => patchCategory({ name: event.target.value })}
                    />
                  </label>
                  <label>
                    ID категории
                    <input value={selected.id} readOnly />
                  </label>
                  <label>
                    Описание
                    <input
                      value={selected.description}
                      onChange={(event) => patchCategory({ description: event.target.value })}
                    />
                  </label>
                  <label>
                    Эмодзи
                    <input
                      value={selected.emoji}
                      onChange={(event) => patchCategory({ emoji: event.target.value })}
                      placeholder="🎫"
                    />
                  </label>
                  <label>
                    Шаблон имени канала
                    <input
                      value={selected.channelName}
                      onChange={(event) => patchCategory({ channelName: event.target.value })}
                    />
                    <small>
                      Подстановки: {'{id}'} и {'{user}'}
                    </small>
                  </label>
                  <label>
                    Discord-категория
                    <select
                      value={selected.parentId}
                      onChange={(event) => patchCategory({ parentId: event.target.value })}
                    >
                      {guild.channels
                        .filter((channel) => channel.type === 4)
                        .map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            {channel.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Роли поддержки
                    <select
                      multiple
                      value={selected.supportRoles}
                      onChange={(event) =>
                        patchCategory({
                          supportRoles: Array.from(event.target.selectedOptions).map(
                            (option) => option.value,
                          ),
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
                  <label>
                    Роль для уведомления
                    <select
                      value={selected.mentionRole || ''}
                      onChange={(event) => patchCategory({ mentionRole: event.target.value || null })}
                    >
                      <option value="">Без упоминания</option>
                      {guild.roles
                        .filter((role) => selected.supportRoles.includes(role.id))
                        .map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={selected.enabled}
                      onChange={(event) => patchCategory({ enabled: event.target.checked })}
                    />
                    Доступна для создания
                  </label>
                </div>
                <h3>Форма перед созданием</h3>
                {selected.questions.map((question, index) => (
                  <div className="module-toolbar" key={question.id}>
                    <input
                      aria-label={'Вопрос ' + (index + 1)}
                      value={question.label}
                      onChange={(event) =>
                        patchCategory({
                          questions: selected.questions.map((item, i) =>
                            i === index ? { ...item, label: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={question.required}
                        onChange={(event) =>
                          patchCategory({
                            questions: selected.questions.map((item, i) =>
                              i === index ? { ...item, required: event.target.checked } : item,
                            ),
                          })
                        }
                      />
                      Обязательный
                    </label>
                    <button
                      className="button"
                      onClick={() =>
                        patchCategory({ questions: selected.questions.filter((_, i) => i !== index) })
                      }
                    >
                      Удалить
                    </button>
                  </div>
                ))}
                <button
                  className="button"
                  disabled={selected.questions.length >= 5}
                  onClick={() =>
                    patchCategory({
                      questions: [
                        ...selected.questions,
                        {
                          id: 'q-' + crypto.randomUUID().slice(0, 8),
                          label: 'Опишите ситуацию',
                          required: true,
                        },
                      ],
                    })
                  }
                >
                  Добавить вопрос
                </button>
                <h3>Первое сообщение</h3>
                <BlockEditor
                  key={selected.id}
                  blocks={selected.intro}
                  onChange={(intro) => patchCategory({ intro })}
                />
                <div className="module-toolbar">
                  {[-1, 1].map((direction) => (
                    <button
                      key={direction}
                      className="button"
                      disabled={
                        categoryIndex + direction < 0 ||
                        categoryIndex + direction >= settings.document.categories.length
                      }
                      onClick={() => {
                        const categories = [...settings.document.categories];
                        [categories[categoryIndex], categories[categoryIndex + direction]] = [
                          categories[categoryIndex + direction],
                          categories[categoryIndex],
                        ];
                        patch({ categories });
                        setCategoryIndex(categoryIndex + direction);
                      }}
                    >
                      {direction < 0 ? 'Категория выше' : 'Категория ниже'}
                    </button>
                  ))}
                </div>
                <button
                  className="button"
                  onClick={() => {
                    if (window.confirm('Удалить категорию из настроек?')) {
                      patch({
                        categories: settings.document.categories.filter(
                          (_, index) => index !== categoryIndex,
                        ),
                      });
                      setCategoryIndex(0);
                    }
                  }}
                >
                  Удалить категорию
                </button>
              </>
            )}
          </section>
          <section className="module-card">
            <h2>Панель создания тикетов</h2>
            <BlockEditor blocks={settings.document.panel} onChange={(panel) => patch({ panel })} />
            <details>
              <summary>Предпросмотр</summary>
              <BlocksPreview blocks={settings.document.panel} />
              <p>Бот добавит кнопку «Создать тикет» при публикации.</p>
            </details>
            <div className="module-toolbar">
              <button
                className="button primary"
                disabled={busy || !dirty}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ document: TicketConfig; version: number }>(
                      '/tickets/settings',
                      'PUT',
                      { document: settings.document, version: settings.version },
                    );
                    setSettings({ ...settings, ...result });
                    setSaved(JSON.stringify(result.document));
                  })
                }
              >
                Сохранить настройки{dirty ? ' *' : ''}
              </button>
              <select
                aria-label="Канал панели тикетов"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                <option value="">Канал публикации</option>
                {guild.channels
                  .filter((channel) => channel.type === 0)
                  .map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      #{channel.name}
                    </option>
                  ))}
              </select>
              <button
                className="button"
                disabled={busy || dirty || !channel}
                onClick={() =>
                  void run(async () => {
                    if (!window.confirm('Опубликовать панель тикетов в выбранном канале?')) return;
                    await api('/tickets/publish', 'POST', { channelId: channel });
                    setSettings(await api<Settings>('/tickets/settings'));
                  })
                }
              >
                Опубликовать панель
              </button>
            </div>
            {settings.panels.map((panel) => (
              <p key={panel.id}>
                Канал {panel.channel_id}: {panel.state}
                {panel.error ? ' · ' + panel.error : ''}
              </p>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
