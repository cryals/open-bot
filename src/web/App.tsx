import { documentation } from './documentation.js';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  ClipboardList,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  Gamepad2,
  History,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Radio,
  Save,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  paginate,
  pageBlocks,
  infoBlocks,
  type GuildInfo,
  type RuleKey,
  type RulePage,
  type RulesDocument,
  type SessionUser,
  type Workspace,
} from '../shared/rules.js';
import { api, ApiError, setCsrf } from './api.js';
import { Preview } from './Preview.js';
import { BlockEditor } from './BlockEditor.js';
import { blockText } from '../shared/blocks.js';
import { BlocksPreview } from './BlockPreview.js';
import { useActivity } from './activity.js';
import { Logo } from './Logo.js';
import { ApplicationSettings } from './ApplicationSettings.js';
import type { Access } from '../shared/modules.js';
import { capabilityNames } from '../shared/settings.js';
import type { ModuleKind } from './Modules.js';
const Modules = lazy(() => import('./Modules.js').then((module) => ({ default: module.Modules })));
const moduleTitles: Record<ModuleKind, string> = {
  tickets: 'Тикеты',
  servers: 'Игровые серверы',
  watchdog: 'SS14 Watchdog',
  metrics: 'Метрики',
  community: 'Модули сообщества',
  moderation: 'Модерация',
};
const Composer = lazy(() => import('./Composer.js').then((module) => ({ default: module.Composer })));
const ActivityView = lazy(() =>
  import('./ActivityView.js').then((module) => ({ default: module.ActivityView })),
);

type Mode = 'rules' | 'settings' | 'history' | 'messages' | 'info' | 'activity' | ModuleKind;
type LoginState =
  { kind: 'loading' } | { kind: 'guest'; error?: string } | { kind: 'member'; user: SessionUser };
type ModalProps = {
  title: string;
  children: ReactNode;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
};
function ConfirmModal({ title, children, confirm, onConfirm, onClose }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Отмена
        </button>
        <button className="button primary" onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
const date = (value: number) =>
  new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(value);

export function App() {
  const [login, setLogin] = useState<LoginState>({ kind: 'loading' });
  const [access, setAccess] = useState<Access | null>(null);
  const activityError = useActivity(
    login.kind === 'member',
    access?.admin
      ? '/activity'
      : access?.formReviewer || capabilityNames.some((key) => access?.[key])
        ? '/community/activity'
        : '/tickets/activity',
  );
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [document, setDocument] = useState<RulesDocument | null>(null);
  const [guild, setGuild] = useState<GuildInfo | null>(null);
  const [mode, setMode] = useState<Mode>('rules');
  const [key, setKey] = useState<RuleKey>('discord');
  const [selectedId, setSelectedId] = useState('');
  const [previewIndex, setPreviewIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const [modal, setModal] = useState<ModalProps | null>(null);
  const [composerDirty, setComposerDirty] = useState(false);
  const [composerOpened, setComposerOpened] = useState(false);
  const [modulesOpened, setModulesOpened] = useState(false);
  const isModule = mode in moduleTitles;
  const dirty = Boolean(
    workspace && document && JSON.stringify(workspace.document) !== JSON.stringify(document),
  );

  useEffect(() => {
    const warning = (event: BeforeUnloadEvent) => {
      if (dirty || composerDirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warning);
    return () => window.removeEventListener('beforeunload', warning);
  }, [dirty, composerDirty]);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const me = await api<{ user: SessionUser; csrf: string; permissions: Access }>('/me');
        setCsrf(me.csrf);
        if (!alive) return;
        setAccess(me.permissions);
        if (!me.permissions.admin) {
          setLogin({ kind: 'member', user: me.user });
          return;
        }
        const [loaded, info] = await Promise.all([api<Workspace>('/workspace'), api<GuildInfo>('/guild')]);
        if (!alive) return;
        setWorkspace(loaded);
        setDocument(loaded.document);
        setGuild(info);
        setSelectedId(loaded.document.rulesets[0].pages[0].id);
        setLogin({ kind: 'member', user: me.user });
      } catch (cause) {
        if (!alive) return;
        const queryError = new URLSearchParams(location.search).get('error');
        setLogin({
          kind: 'guest',
          error:
            queryError === 'forbidden'
              ? 'Для входа нужна роль администратора этого сервера.'
              : queryError === 'cancelled'
                ? 'Вход отменён. Вы можете попробовать ещё раз.'
                : cause instanceof ApiError && cause.status === 401
                  ? undefined
                  : cause instanceof Error
                    ? cause.message
                    : 'Не удалось загрузить панель',
        });
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!success) return;
    const timeout = window.setTimeout(() => setSuccess(''), 6000);
    return () => window.clearTimeout(timeout);
  }, [success]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие');
      if (cause instanceof ApiError && [401, 403].includes(cause.status))
        setLogin({ kind: 'guest', error: cause.message });
    } finally {
      setBusy(false);
    }
  }
  function accept(next: Workspace, submitted?: RulesDocument) {
    setWorkspace(next);
    // An upload can finish while a save/publish request is in flight.
    setDocument((current) => (submitted && current !== submitted ? current : next.document));
  }
  function switchSet(next: RuleKey) {
    setKey(next);
    setMode('rules');
    setSidebar(false);
    setPreviewIndex(0);
    setSelectedId(document!.rulesets.find((set) => set.key === next)!.pages[0].id);
  }
  const current = document?.rulesets.find((set) => set.key === key);
  const selected = current?.pages.find((page) => page.id === selectedId) || current?.pages[0];
  function updateSet(values: Partial<NonNullable<typeof current>>) {
    setDocument(
      (previous) =>
        previous && {
          ...previous,
          rulesets: previous.rulesets.map((set) =>
            set.key === key ? { ...set, ...values } : set,
          ) as RulesDocument['rulesets'],
        },
    );
  }
  function updatePage(values: Partial<RulePage>) {
    const pageId = selected!.id;
    setDocument(
      (previous) =>
        previous && {
          ...previous,
          rulesets: previous.rulesets.map((set) =>
            set.key === key
              ? {
                  ...set,
                  pages: set.pages.map((page) => (page.id === pageId ? { ...page, ...values } : page)),
                }
              : set,
          ) as RulesDocument['rulesets'],
        },
    );
  }
  function selectPage(id: string) {
    setSelectedId(id);
    setPreviewIndex(
      Math.max(
        0,
        paginate(current!).findIndex((page) => page.sourceId === id),
      ),
    );
    setSidebar(false);
  }
  function movePage(id: string, delta: number) {
    const pages = [...current!.pages];
    const from = pages.findIndex((page) => page.id === id);
    [pages[from], pages[from + delta]] = [pages[from + delta], pages[from]];
    updateSet({ pages });
  }
  async function save() {
    await run(async () => {
      accept(await api<Workspace>('/draft', 'PUT', { document, version: workspace!.version }), document!);
      setSuccess('Черновик сохранён');
    });
  }
  function publish() {
    setModal({
      title: 'Опубликовать правила?',
      confirm: 'Опубликовать',
      onClose: () => setModal(null),
      onConfirm: () => {
        setModal(null);
        void run(async () => {
          accept(await api<Workspace>('/publish', 'POST', { version: workspace!.version }), document!);
          setSuccess('Информация и правила опубликованы в Discord');
        });
      },
      children: (
        <p>
          Сохранённый черновик станет доступен участникам в канале{' '}
          <strong>
            #
            {guild?.channels.find((channel) => channel.id === workspace?.settings.channelId)?.name ||
              'правил'}
          </strong>
          . Существующее сообщение будет обновлено.
        </p>
      ),
    });
  }

  if (login.kind === 'loading')
    return (
      <main className="loading-screen">
        <LoaderCircle className="spinning" />
        <p>Открываем панель Open Bot…</p>
      </main>
    );
  if (login.kind === 'member' && access && !access.admin)
    return (
      <main className="ticket-only">
        <header>
          <h1>Open Bot · Управление сервером</h1>
          <div>
            <a className="button" href={documentation('user/tickets')} target="_blank" rel="noreferrer">
              Руководство
            </a>
            <button
              className="button"
              onClick={() =>
                void run(async () => {
                  await api('/logout', 'POST');
                  setLogin({ kind: 'guest' });
                })
              }
            >
              Выйти
            </button>
          </div>
        </header>
        <Suspense fallback={<p>Открываем тикеты…</p>}>
          <nav className="module-toolbar">
            {access.ticketView && (
              <button className="button" onClick={() => setMode('tickets')}>
                Тикеты
              </button>
            )}
            {(access.moderationView || access.moderationManage) && (
              <button className="button" onClick={() => setMode('moderation')}>
                Модерация
              </button>
            )}
            <button className="button" onClick={() => setMode('community')}>
              Модули
            </button>
          </nav>
          <Modules
            kind={
              mode === 'tickets' && access.ticketView
                ? 'tickets'
                : mode === 'moderation' && (access.moderationView || access.moderationManage)
                  ? 'moderation'
                  : mode === 'rules' && access.ticketView
                    ? 'tickets'
                    : 'community'
            }
            access={access}
          />
        </Suspense>
      </main>
    );
  if (login.kind === 'guest' || !workspace || !document || !current || !selected)
    return (
      <main className="login-screen">
        <div className="login-brand">
          <Logo className="logo-small" /> Open Bot
        </div>
        <div className="login-card">
          <div className="login-icon">
            <Logo className="logo-large" />
          </div>
          <h1>
            Правила начинаются
            <br />с ясности.
          </h1>
          <p>
            Open Bot — бот для управления серверами Discord.
            <br />
            Редактируйте правила и публикуйте сообщения от имени бота.
          </p>
          {login.kind === 'guest' && login.error && (
            <div className="alert error" role="alert">
              {login.error}
            </div>
          )}
          <a className="button primary login-button" href="/auth/discord">
            <ShieldCheck size={18} />
            Войти через Discord
            <ArrowUpRight size={18} />
          </a>
          <small>Доступ для администрации Discord-сервера</small>
          <a className="text-link" href={documentation()} target="_blank" rel="noreferrer">
            Документация
          </a>
        </div>
        <p className="login-footer">OPEN BOT / УПРАВЛЕНИЕ DISCORD-СЕРВЕРОМ</p>
      </main>
    );

  return (
    <div className="app-shell">
      {sidebar && (
        <button className="sidebar-backdrop" aria-label="Закрыть меню" onClick={() => setSidebar(false)} />
      )}
      <aside className={'sidebar ' + (sidebar ? 'is-open' : '')}>
        <div className="brand">
          <span className="brand-symbol">
            <Logo />
          </span>
          <div>
            Open Bot<small>Управление сервером</small>
          </div>
        </div>
        <div className="nav-label">РАЗДЕЛЫ</div>
        <nav className="primary-nav" aria-label="Разделы панели">
          <button
            className={mode === 'info' ? 'active' : ''}
            onClick={() => {
              setMode('info');
              setSidebar(false);
            }}
          >
            <Radio size={18} />
            Информация
            <ChevronRight size={15} />
          </button>
          <button
            className={mode === 'rules' && key === 'discord' ? 'active' : ''}
            onClick={() => switchSet('discord')}
          >
            <MessageSquare size={18} />
            Правила Discord
            <ChevronRight size={15} />
          </button>
          <button
            className={mode === 'rules' && key === 'game' ? 'active' : ''}
            onClick={() => switchSet('game')}
          >
            <Gamepad2 size={18} />
            Правила игры
            <ChevronRight size={15} />
          </button>
          <button
            className={mode === 'messages' ? 'active' : ''}
            onClick={() => {
              setComposerOpened(true);
              setMode('messages');
              setSidebar(false);
            }}
          >
            <Send size={18} />
            Сообщения бота
            <ChevronRight size={15} />
          </button>
          {(Object.entries(moduleTitles) as [ModuleKind, string][]).map(([id, title]) => (
            <button
              key={id}
              className={mode === id ? 'active' : ''}
              onClick={() => {
                setModulesOpened(true);
                setMode(id);
                setSidebar(false);
              }}
            >
              <Server size={18} />
              {title}
              <ChevronRight size={15} />
            </button>
          ))}
        </nav>
        {mode === 'rules' && (
          <div className="page-nav">
            <div className="nav-label">
              СТРАНИЦЫ <span>{current.pages.length}</span>
            </div>
            <div className="page-list">
              {current.pages.map((page, index) => (
                <div
                  className={
                    'page-row ' +
                    (selected.id === page.id ? 'selected' : '') +
                    (!page.enabled ? ' is-disabled' : '')
                  }
                  key={page.id}
                >
                  <button className="page-select" onClick={() => selectPage(page.id)}>
                    <span className="page-number">{String(index + 1).padStart(2, '0')}</span>
                    <span>{page.title}</span>
                  </button>
                  <div className="reorder">
                    <button
                      aria-label={'Поднять ' + page.title}
                      disabled={busy || index === 0}
                      onClick={() => movePage(page.id, -1)}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      aria-label={'Опустить ' + page.title}
                      disabled={busy || index === current.pages.length - 1}
                      onClick={() => movePage(page.id, 1)}
                    >
                      <ArrowDown size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              className="add-page"
              disabled={busy || current.pages.length >= 100}
              onClick={() => {
                const page = {
                  id: crypto.randomUUID(),
                  title: 'Новый раздел',
                  body: 'Текст правил',
                  enabled: true,
                };
                updateSet({ pages: [...current.pages, page] });
                setSelectedId(page.id);
                setPreviewIndex(paginate(current).length);
              }}
            >
              <Plus size={15} />
              Добавить страницу
            </button>
          </div>
        )}
        <nav className="secondary-nav" aria-label="Настройки панели">
          <button
            className={mode === 'activity' ? 'active' : ''}
            onClick={() => {
              setMode('activity');
              setSidebar(false);
            }}
          >
            <ClipboardList size={17} />
            Журнал действий
          </button>
          <button
            className={mode === 'settings' ? 'active' : ''}
            onClick={() => {
              setMode('settings');
              setSidebar(false);
            }}
          >
            <Settings size={17} />
            Настройки
          </button>
          <button
            className={mode === 'history' ? 'active' : ''}
            onClick={() => {
              setMode('history');
              setSidebar(false);
            }}
          >
            <History size={17} />
            История публикаций
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="guild">
            <span className="connection-dot" />
            <div>
              Discord
              <small>{guild?.ready ? 'Бот подключён' : 'Бот переподключается'}</small>
            </div>
          </div>
          <button
            className="logout"
            title="Выйти"
            aria-label="Выйти"
            disabled={busy}
            onClick={() => {
              if ((dirty || composerDirty) && !window.confirm('Выйти без сохранения изменений?')) return;
              void run(async () => {
                await api('/logout', 'POST');
                setLogin({ kind: 'guest' });
              });
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Открыть меню"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <span>Правила</span>
            <ChevronRight size={14} />
            <strong>
              {isModule
                ? moduleTitles[mode as ModuleKind]
                : mode === 'rules'
                  ? key === 'game'
                    ? 'Игра'
                    : 'Discord'
                  : mode === 'settings'
                    ? 'Настройки'
                    : mode === 'messages'
                      ? 'Сообщения бота'
                      : mode === 'info'
                        ? 'Информация'
                        : mode === 'activity'
                          ? 'Журнал действий'
                          : 'История'}
            </strong>
          </div>
          <div className="user">
            <span className="user-avatar">
              {login.kind === 'member' ? login.user.name.slice(0, 1).toUpperCase() : 'A'}
            </span>
            {login.kind === 'member' && login.user.name}
          </div>
        </header>
        <section className="page-heading">
          <div>
            <h1>
              {isModule
                ? moduleTitles[mode as ModuleKind]
                : mode === 'rules'
                  ? 'Редактор правил'
                  : mode === 'settings'
                    ? 'Настройки'
                    : mode === 'messages'
                      ? 'Сообщения бота'
                      : mode === 'info'
                        ? 'Информация'
                        : mode === 'activity'
                          ? 'Журнал действий'
                          : 'История публикаций'}
            </h1>
            <p>
              {isModule
                ? 'Управление модулем Open Bot.'
                : mode === 'rules'
                  ? 'Понятные правила. Одна актуальная версия.'
                  : mode === 'settings'
                    ? 'Канал публикации и доступ к панели.'
                    : mode === 'messages'
                      ? 'Создавайте сообщения из блоков и отправляйте от имени бота.'
                      : mode === 'info'
                        ? 'Главное сообщение: правила, полезные ссылки и информация о проекте.'
                        : mode === 'activity'
                          ? 'Нажатия, изменения текста, публикации и действия бота.'
                          : 'Опубликованные версии можно вернуть в черновик.'}
            </p>
          </div>
          <div className="heading-actions" hidden={mode !== 'rules' && mode !== 'info'}>
            <span className={'save-state ' + (dirty ? 'unsaved' : '')}>
              {dirty ? (
                <>
                  <span className="change-dot" />
                  Есть изменения
                </>
              ) : (
                <>
                  <Check size={14} />
                  Сохранено
                </>
              )}
            </span>
            <button className="button" disabled={busy || !dirty} onClick={() => void save()}>
              <Save size={16} />
              Сохранить
            </button>
            <button
              className="button primary"
              disabled={busy || dirty || !workspace.settings.channelId}
              title={
                dirty
                  ? 'Сначала сохраните изменения'
                  : !workspace.settings.channelId
                    ? 'Выберите канал в настройках'
                    : 'Опубликовать сохранённые правила'
              }
              onClick={publish}
            >
              {busy ? <LoaderCircle size={16} className="spinning" /> : <Send size={16} />}Опубликовать
            </button>
          </div>
        </section>
        {error && (
          <div className="alert error" role="alert">
            {error}
            <button className="icon-button" aria-label="Скрыть ошибку" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {activityError && (
          <div className="alert error" role="alert">
            {activityError}
          </div>
        )}
        {modulesOpened && access && (
          <div hidden={!isModule}>
            <Suspense fallback={<p>Загрузка модуля…</p>}>
              <Modules kind={isModule ? (mode as ModuleKind) : 'servers'} access={access} guild={guild} />
            </Suspense>
          </div>
        )}
        {mode === 'activity' && (
          <Suspense fallback={<p className="composer-loading">Открываем журнал…</p>}>
            <ActivityView />
          </Suspense>
        )}
        {success && (
          <div className="alert success" role="status">
            <CheckCircle2 size={17} />
            {success}
          </div>
        )}
        {mode === 'info' && (
          <div className="workspace-grid">
            <section className="editor-panel">
              <fieldset disabled={busy}>
                <div className="info-editor-hint">
                  <BookOpen size={18} />
                  <p>
                    Соберите информационное сообщение из блоков. Добавляйте контейнеры для вики, лаунчера,
                    поддержки и документов. В блоке «Ряд кнопок» доступны ссылки и кнопка «Читать правила».
                  </p>
                </div>
                <BlockEditor
                  blocks={infoBlocks(document)}
                  onChange={(launcherBlocks) =>
                    setDocument((previous) => previous && { ...previous, launcherBlocks })
                  }
                />
                <p className="editor-hint">
                  <ShieldCheck size={15} />
                  Сохраните изменения и нажмите «Опубликовать», чтобы обновить существующее сообщение.
                </p>
              </fieldset>
            </section>
            <aside className="preview-panel">
              <div className="preview-heading">Информационное сообщение в Discord</div>
              <div className="discord-surface">
                <div className="discord-author">
                  <span className="bot-avatar">
                    <Logo />
                  </span>
                  <strong>Open Bot</strong>
                  <span className="app-tag">APP</span>
                </div>
                <BlocksPreview blocks={infoBlocks(document)} />
              </div>
            </aside>
          </div>
        )}
        {mode === 'rules' && (
          <div className="workspace-grid">
            <section className="editor-panel">
              <fieldset disabled={busy}>
                <details className="intro-editor">
                  <summary>
                    <BookOpen size={17} />
                    <div>
                      Вступление раздела<small>Показывается над каждой страницей</small>
                    </div>
                    <ChevronRight size={16} />
                  </summary>
                  <div className="intro-fields">
                    <label>
                      Название раздела
                      <input
                        value={current.title}
                        maxLength={120}
                        onChange={(event) => updateSet({ title: event.target.value })}
                      />
                    </label>
                    <label>
                      Вступление
                      <textarea
                        rows={5}
                        value={current.intro}
                        maxLength={800}
                        onChange={(event) => updateSet({ intro: event.target.value })}
                      />
                    </label>
                  </div>
                </details>
                <div className="editor-card" key={selected.id}>
                  <div className="editor-card-header">
                    <span>
                      <FileText size={17} />
                      Страница {current.pages.findIndex((page) => page.id === selected.id) + 1} из{' '}
                      {current.pages.length}
                    </span>
                    <button
                      className="icon-button danger"
                      aria-label="Удалить страницу"
                      disabled={current.pages.length === 1}
                      onClick={() => {
                        setModal({
                          title: 'Удалить страницу?',
                          children: (
                            <p>
                              Страница «{selected.title}» будет удалена из черновика. Опубликованные правила
                              изменятся только после публикации.
                            </p>
                          ),
                          confirm: 'Удалить',
                          onClose: () => setModal(null),
                          onConfirm: () => {
                            updateSet({ pages: current.pages.filter((page) => page.id !== selected.id) });
                            setSelectedId(current.pages.find((page) => page.id !== selected.id)!.id);
                            setPreviewIndex(0);
                            setModal(null);
                          },
                        });
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <label className="title-field">
                    Название страницы
                    <input
                      value={selected.title}
                      maxLength={150}
                      onChange={(event) => updatePage({ title: event.target.value })}
                    />
                  </label>
                  <BlockEditor blocks={pageBlocks(selected)} onChange={(blocks) => updatePage({ blocks })} />
                  <div className="editor-footer">
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={selected.enabled}
                        onChange={(event) => updatePage({ enabled: event.target.checked })}
                      />
                      Показывать страницу
                    </label>
                    <span>
                      {pageBlocks(selected).map(blockText).join('').length.toLocaleString('ru')} символов
                    </span>
                  </div>
                </div>
                <p className="editor-hint">
                  <ShieldCheck size={15} />
                  Изменения видны игрокам только после публикации.
                </p>
              </fieldset>
            </section>
            <Preview set={current} index={previewIndex} onIndex={setPreviewIndex} />
          </div>
        )}
        <div hidden={mode !== 'messages'}>
          {composerOpened && (
            <Suspense fallback={<p className="composer-loading">Открываем редактор…</p>}>
              <Composer
                guild={guild!}
                onDirtyChange={setComposerDirty}
                onError={(cause) => {
                  setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие');
                  if (cause instanceof ApiError && [401, 403].includes(cause.status))
                    setLogin({ kind: 'guest', error: cause.message });
                }}
              />
            </Suspense>
          )}
        </div>
        {mode === 'settings' && (
          <div className="settings-grid">
            <div>
              {guild && (
                <section className="settings-card guild-profile" aria-label="Подключённый Discord-сервер">
                  {guild.iconUrl ? (
                    <img className="guild-profile-icon" src={guild.iconUrl} alt="" width={56} height={56} />
                  ) : (
                    <span className="guild-profile-icon">
                      <Server size={24} aria-hidden="true" />
                    </span>
                  )}
                  <div>
                    <small>Discord-сервер</small>
                    <h2>{guild.name}</h2>
                    <p>
                      ID: <code>{guild.id}</code>
                    </p>
                  </div>
                </section>
              )}
              <SettingsForm
                workspace={workspace}
                guild={guild!}
                busy={busy}
                onSave={async (values) => {
                  await run(async () => {
                    const next = await api<Workspace>('/settings', 'PUT', values);
                    setWorkspace(
                      (previous) =>
                        previous && { ...previous, settings: next.settings, revisions: next.revisions },
                    );
                    setSuccess('Настройки сохранены');
                  });
                }}
              />
              <section className="settings-card">
                <h2>Публичное сообщение</h2>
                <p>Настройте контейнеры, изображения и кнопки в разделе «Информация».</p>
                <button className="button" onClick={() => setMode('info')}>
                  <Radio size={16} />
                  Открыть конструктор информации
                </button>
              </section>
              {guild && <ApplicationSettings guild={guild} />}
            </div>
            <aside className="settings-card status-card">
              <Radio size={24} />
              <h2>Публикация</h2>
              <p>
                {workspace.settings.publishedRevision
                  ? 'Опубликована версия №' + workspace.settings.publishedRevision
                  : 'Правила ещё не опубликованы'}
              </p>
              {workspace.settings.messageId && (
                <a
                  className="text-link"
                  href={`https://discord.com/channels/${guild?.id}/${workspace.settings.messageChannelId}/${workspace.settings.messageId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть сообщение
                  <ArrowUpRight size={15} />
                </a>
              )}
              <hr />
              <small>ID сервера</small>
              <code>{guild?.id}</code>
              <small>Последнее сохранение</small>
              <p>{date(workspace.updatedAt)}</p>
            </aside>
          </div>
        )}
        {mode === 'history' && (
          <section className="history-card">
            {workspace.revisions.length ? (
              <div className="revision-list">
                {workspace.revisions.map((revision) => (
                  <div className="revision" key={revision.id}>
                    <span className="revision-icon">
                      <History size={20} />
                    </span>
                    <div>
                      <h2>
                        Версия №{revision.id}
                        {workspace.settings.publishedRevision === revision.id && (
                          <span className="current-label">Опубликована</span>
                        )}
                      </h2>
                      <p>
                        {date(revision.createdAt)} · Автор {revision.actor}
                      </p>
                    </div>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        setModal({
                          title: 'Вернуть версию в черновик?',
                          confirm: 'Вернуть в черновик',
                          onClose: () => setModal(null),
                          children: (
                            <p>
                              Черновик будет заменён версией №{revision.id}. После проверки вы сможете
                              опубликовать её заново.{dirty ? ' Несохранённые изменения будут потеряны.' : ''}
                            </p>
                          ),
                          onConfirm: () => {
                            setModal(null);
                            void run(async () => {
                              const next = await api<Workspace>('/restore/' + revision.id, 'POST', {
                                version: workspace.version,
                              });
                              accept(next);
                              setSelectedId(next.document.rulesets[0].pages[0].id);
                              setKey('discord');
                              setMode('rules');
                              setPreviewIndex(0);
                              setSuccess('Версия возвращена в черновик. Проверьте её перед публикацией.');
                            });
                          },
                        })
                      }
                    >
                      В черновик
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <History size={32} />
                <h2>Пока нет публикаций</h2>
                <p>Выберите канал в настройках и опубликуйте первую версию правил.</p>
                <button className="button" onClick={() => setMode('settings')}>
                  Открыть настройки
                </button>
              </div>
            )}
          </section>
        )}
        <footer className="main-footer">
          <span>
            Open Bot · Релиз 1.3 ·{' '}
            <a href={documentation()} target="_blank" rel="noreferrer">
              Вики
            </a>
          </span>
          <span>Черновик v{workspace.version}</span>
        </footer>
      </main>
      {modal && <ConfirmModal {...modal} />}
    </div>
  );
}

function SettingsForm({
  workspace,
  guild,
  busy,
  onSave,
}: {
  workspace: Workspace;
  guild: GuildInfo;
  busy: boolean;
  onSave: (values: {
    channelId: string | null;
    adminRoleId: string | null;
    logChannelId: string | null;
  }) => Promise<void>;
}) {
  const [channelId, setChannelId] = useState(workspace.settings.channelId || '');
  const [adminRoleId, setAdminRoleId] = useState(workspace.settings.adminRoleId || '');
  const [logChannelId, setLogChannelId] = useState(workspace.settings.logChannelId || '');
  return (
    <form
      className="settings-card"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          channelId: channelId || null,
          adminRoleId: adminRoleId || null,
          logChannelId: logChannelId || null,
        });
      }}
    >
      <h2>Канал и доступ</h2>
      <p>Бот публикует одно сообщение и обновляет его при следующих публикациях.</p>
      <fieldset disabled={busy}>
        <label>
          Канал информационного сообщения
          <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
            <option value="">Выберите канал</option>
            {guild.channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Роль администратора
          <select value={adminRoleId} onChange={(event) => setAdminRoleId(event.target.value)}>
            <option value="">Владелец и роли с правом «Администратор»</option>
            {guild.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Канал журнала действий
          <select value={logChannelId} onChange={(event) => setLogChannelId(event.target.value)}>
            <option value="">Не отправлять в Discord</option>
            {guild.channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </label>
        <p className="field-help">
          Все события сохраняются в журнале панели и JSONL. В выбранный канал бот отправляет компактные записи
          с автором и разницей по строкам. Полная разница остаётся в панели.
        </p>
        <p className="field-help">
          Владелец сервера сохраняет доступ к панели. Проверка роли выполняется при каждом действии.
        </p>
        <button className="button primary" type="submit">
          <Save size={16} />
          Сохранить настройки
        </button>
      </fieldset>
    </form>
  );
}
