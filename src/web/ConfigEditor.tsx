import type { GuildInfo } from '../shared/rules.js';
import type { Block } from '../shared/blocks.js';
import { BlockEditor } from './BlockEditor.js';
export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
};
const titles: Record<string, string> = {
  phishingSource: 'Источник phishing-доменов',
  youtubeSearchBudget: 'Суточный бюджет поиска YouTube',
  youtubeLiveInterval: 'Интервал поиска эфиров YouTube',
  enabled: 'Включено',
  id: 'ID',
  name: 'Название',
  title: 'Заголовок',
  description: 'Описание',
  rules: 'Правила',
  panels: 'Панели',
  commands: 'Команды',
  forms: 'Формы',
  feeds: 'Подписки',
  boards: 'Доски',
  channelId: 'Канал',
  channels: 'Каналы действия',
  sourceChannels: 'Разрешённые источники',
  roles: 'Роли доступа',
  exceptRoles: 'Исключённые роли',
  exceptChannels: 'Исключённые каналы',
  requiredRoles: 'Обязательные роли',
  forbiddenRoles: 'Запрещающие роли',
  blockedRoles: 'Запрещённые роли',
  reviewRoles: 'Роли обработчиков',
  roleId: 'Выдаваемая роль',
  emoji: 'Эмодзи',
  threshold: 'Порог',
  windowSeconds: 'Окно, секунд',
  duration: 'Длительность, секунд',
  seconds: 'Интервал, секунд',
  priority: 'Приоритет',
  filter: 'Фильтр',
  action: 'Действие',
  observe: 'Режим наблюдения',
  native: 'Discord Native AutoMod',
  values: 'Значения / фразы',
  allowlist: 'Разрешённые значения',
  wholeWords: 'Слова целиком',
  minLength: 'Минимальная длина',
  evidenceDays: 'Хранение фрагмента нарушения, дней',
  phishingDomains: 'Phishing-домены',
  phishingUpdatedAt: 'Обновление списка',
  eventChannel: 'Канал событий',
  questions: 'Вопросы',
  label: 'Подпись',
  choices: 'Варианты',
  required: 'Обязательный',
  type: 'Тип',
  options: 'Варианты панели',
  kind: 'Способ выбора',
  mode: 'Режим',
  maxSelected: 'Максимум вариантов',
  blocks: 'Сообщение',
  response: 'Ответ',
  responses: 'Варианты ответа',
  trigger: 'Триггер',
  match: 'Совпадение',
  caseSensitive: 'Учитывать регистр',
  userCooldown: 'Cooldown участника, секунд',
  channelCooldown: 'Cooldown канала, секунд',
  cooldown: 'Cooldown, секунд',
  deleteAfter: 'Удалить ответ через, секунд (0 — оставить)',
  destination: 'Канал ответа',
  arguments: 'Аргументы',
  actions: 'Действия',
  value: 'Значение',
  safeRoles: 'Разрешённые безопасные роли',
  private: 'Личный ответ',
  registerSlash: 'Зарегистрировать slash-команду',
  prize: 'Приз',
  image: 'Изображение HTTPS',
  startsAt: 'Начало',
  endsAt: 'Окончание',
  winners: 'Победителей',
  managerRoles: 'Роли менеджеров',
  minAccountDays: 'Возраст аккаунта, дней',
  dailyBonus: 'Ежедневный бонус',
  referralBonus: 'Реферальный бонус',
  maxChances: 'Максимум шансов',
  rewardRole: 'Наградная роль',
  notifyDm: 'Уведомлять в ЛС',
  membersOnly: 'Только участники сервера',
  appeal: 'Апелляция',
  anonymous: 'Скрывать автора от обработчиков',
  onePerUser: 'Одна заявка на участника',
  opensAt: 'Начало приёма',
  closesAt: 'Окончание приёма',
  retentionDays: 'Хранение, дней',
  thread: 'Создавать обсуждение',
  mentionRole: 'Уведомляемая роль',
  grantRole: 'Роль при принятии',
  ticketCategory: 'Связанная категория Ticket',
  provider: 'Платформа',
  source: 'Источник',
  types: 'Типы публикаций',
  keywords: 'Ключевые слова',
  flairs: 'Flair-фильтр',
  attachmentTypes: 'Типы вложений',
  allowNsfw: 'Разрешать NSFW (только возрастной канал)',
  stripHashtags: 'Убирать хештеги',
  backfill: 'Первые исторические записи (0 — без истории)',
  voterRoles: 'Роли голосующих',
  allowBots: 'Сообщения ботов',
  allowSelf: 'Самоголосование',
  belowThreshold: 'Ниже порога',
  time: 'Время HH:MM',
  timezone: 'Часовой пояс',
  maxFileMb: 'Лимит файла, МБ',
  maxArchiveMb: 'Квота копии, МБ',
  includeMembers: 'Сохранять назначения ролей',
  includeMessages: 'Сохранять последние сообщения',
  messagesPerChannel: 'Сообщений на канал / ветку',
  keepCopies: 'Хранить последних копий',
  excludedChannels: 'Исключённые каналы',
  youngAccountSeconds: 'Возраст молодых аккаунтов, секунд',
  quietSeconds: 'Окно тишины, секунд',
  automatic: 'Автоматические меры',
  quarantineRole: 'Карантинная роль',
  lockdown: 'Закрывать каналы',
  slowmodeSeconds: 'Slowmode во время рейда, секунд',
  expiresAt: 'Действует до',
  messageId: 'ID существующего сообщения',
};
export function ConfigEditor({
  schema,
  value,
  onChange,
  guild,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  guild?: GuildInfo | null;
}) {
  const resolve = (part: JsonSchema): JsonSchema => {
    if (!part.$ref) return part;
    const target = part.$ref
      .split('/')
      .slice(1)
      .reduce<unknown>(
        (object, key) =>
          object && typeof object === 'object' ? (object as Record<string, unknown>)[key] : undefined,
        schema,
      );
    return (target as JsonSchema) || part;
  };
  const base = (part: JsonSchema) => {
    const resolved = resolve(part);
    return resolved.anyOf
      ? resolve(resolved.anyOf.find((item) => item.type !== 'null') || resolved.anyOf[0])
      : resolved;
  };
  function initial(part: JsonSchema, key = ''): unknown {
    part = base(part);
    if (part.default !== undefined) return structuredClone(part.default);
    if (part.const !== undefined) return part.const;
    if (part.enum) return part.enum[0];
    if (part.type === 'object')
      return Object.fromEntries(
        Object.entries(part.properties || {})
          .filter(([name]) => part.required?.includes(name))
          .map(([name, item]) => [name, initial(item, name)]),
      );
    if (part.type === 'array') return [];
    if (part.type === 'boolean') return false;
    if (part.type === 'number' || part.type === 'integer')
      return key.endsWith('At') ? Date.now() : part.minimum || 0;
    return key === 'id' ? crypto.randomUUID() : '';
  }
  function field(
    part: JsonSchema,
    current: unknown,
    set: (value: unknown) => void,
    key: string,
    path: string,
  ): React.ReactNode {
    const raw = resolve(part);
    part = base(raw);
    const label = titles[key] || key;
    const nullable = raw.anyOf?.some((item) => item.type === 'null');
    if (nullable && current === null)
      return (
        <label key={path}>
          {label}
          <button type="button" className="button" onClick={() => set(initial(part, key))}>
            Задать
          </button>
        </label>
      );
    if (part.type === 'object') {
      const object = (current || {}) as Record<string, unknown>;
      return (
        <fieldset key={path} className="module-card">
          <legend>{label}</legend>
          {Object.entries(part.properties || {}).map(([name, child]) => {
            if (object[name] === undefined && !part.required?.includes(name))
              return (
                <button
                  type="button"
                  className="button"
                  key={name}
                  onClick={() => set({ ...object, [name]: initial(child, name) })}
                >
                  Добавить: {titles[name] || name}
                </button>
              );
            return (
              <div key={name}>
                {field(
                  child,
                  object[name],
                  (value) => set({ ...object, [name]: value }),
                  name,
                  path + '.' + name,
                )}
                {!part.required?.includes(name) && (
                  <button
                    className="text-link"
                    type="button"
                    onClick={() => {
                      const next = { ...object };
                      delete next[name];
                      set(next);
                    }}
                  >
                    Убрать необязательное поле
                  </button>
                )}
              </div>
            );
          })}
        </fieldset>
      );
    }
    if (part.type === 'array') {
      const items = (current || []) as unknown[];
      const child = base(part.items || {}),
        variants = child.anyOf || child.oneOf || [];
      const isBlocks =
        ['blocks', 'response', 'panel'].includes(key) ||
        variants.some((variant) => resolve(variant).properties?.type?.const === 'text');
      if (isBlocks)
        return (
          <section key={path}>
            <h3>{label}</h3>
            <BlockEditor blocks={items as Block[]} onChange={set} />
          </section>
        );
      if (guild && /roles$/i.test(key) && child.type === 'string')
        return (
          <label key={path}>
            {label}
            <select
              multiple
              value={items as string[]}
              onChange={(event) => set(Array.from(event.target.selectedOptions, (option) => option.value))}
            >
              {guild.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
        );
      if (guild && /channels$/i.test(key) && child.type === 'string')
        return (
          <label key={path}>
            {label}
            <select
              multiple
              value={items as string[]}
              onChange={(event) => set(Array.from(event.target.selectedOptions, (option) => option.value))}
            >
              {guild.channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.name}
                </option>
              ))}
            </select>
          </label>
        );
      return (
        <section key={path} className="module-card">
          <h3>
            {label} · {items.length}
          </h3>
          {items.map((item, index) => (
            <div className="module-card" key={index}>
              {field(
                child,
                item,
                (value) => set(items.map((previous, i) => (i === index ? value : previous))),
                key === 'responses' ? 'blocks' : key,
                path + '.' + index,
              )}
              <div className="module-toolbar">
                <button
                  type="button"
                  className="button"
                  disabled={index === 0}
                  onClick={() => {
                    const next = [...items];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    set(next);
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={index === items.length - 1}
                  onClick={() => {
                    const next = [...items];
                    [next[index + 1], next[index]] = [next[index], next[index + 1]];
                    set(next);
                  }}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    const copy = structuredClone(item);
                    if (copy && typeof copy === 'object' && !Array.isArray(copy) && 'id' in copy)
                      (copy as { id: string }).id = crypto.randomUUID();
                    set([...items.slice(0, index + 1), copy, ...items.slice(index + 1)]);
                  }}
                >
                  Копировать
                </button>
                <button
                  type="button"
                  className="button danger"
                  onClick={() => set(items.filter((_, i) => i !== index))}
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="button"
            disabled={!!part.maxItems && items.length >= part.maxItems}
            onClick={() => set([...items, initial(child)])}
          >
            Добавить: {label.toLowerCase()}
          </button>
        </section>
      );
    }
    if (part.type === 'boolean')
      return (
        <label className="checkbox" key={path}>
          <input type="checkbox" checked={!!current} onChange={(event) => set(event.target.checked)} />
          {label}
        </label>
      );
    if (part.enum)
      return (
        <label key={path}>
          {label}
          <select value={String(current ?? '')} onChange={(event) => set(event.target.value)}>
            {part.enum.map((option) => (
              <option key={String(option)} value={String(option)}>
                {String(option)}
              </option>
            ))}
          </select>
        </label>
      );
    if (guild && typeof current === 'string' && /channelId$|eventChannel$|destination$/i.test(key))
      return (
        <label key={path}>
          {label}
          <select value={current} onChange={(event) => set(event.target.value || null)}>
            <option value="">Выберите канал</option>
            {guild.channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </label>
      );
    if (guild && typeof current === 'string' && /roleId$|Role$/i.test(key))
      return (
        <label key={path}>
          {label}
          <select value={current} onChange={(event) => set(event.target.value || null)}>
            <option value="">Выберите роль</option>
            {guild.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
      );
    const numeric = part.type === 'integer' || part.type === 'number';
    if (numeric && key.endsWith('At')) {
      const timestamp = Number(current),
        local = timestamp
          ? new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
          : '';
      return (
        <label key={path}>
          {label}
          <input
            type="datetime-local"
            value={local}
            onChange={(event) =>
              set(event.target.value ? new Date(event.target.value).getTime() : nullable ? null : 0)
            }
          />
          <small>Часовой пояс браузера</small>
          {nullable && (
            <button type="button" className="text-link" onClick={() => set(null)}>
              Не задавать
            </button>
          )}
        </label>
      );
    }
    return (
      <label key={path}>
        {label}
        <input
          type={numeric ? 'number' : 'text'}
          value={typeof current === 'number' || typeof current === 'string' ? current : ''}
          min={part.minimum}
          max={part.maximum}
          maxLength={part.maxLength}
          onChange={(event) => set(numeric ? Number(event.target.value) : event.target.value)}
        />
        {key.endsWith('At') && numeric && (
          <small>{current ? new Date(Number(current)).toLocaleString() : 'Unix-время, миллисекунды'}</small>
        )}
        {nullable && (
          <button type="button" className="text-link" onClick={() => set(null)}>
            Не задавать
          </button>
        )}
      </label>
    );
  }
  return <>{field(schema, value, onChange, 'Настройки', 'root')}</>;
}
