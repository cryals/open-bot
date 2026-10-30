import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  Bold,
  Box,
  Braces,
  ChevronDown,
  Code2,
  Copy,
  File,
  GripVertical,
  Heading,
  Image,
  Italic,
  Link,
  List,
  Minus,
  MousePointer2,
  Plus,
  Quote,
  Strikethrough,
  Trash2,
  Underline,
  Upload,
  EyeOff,
  X,
  LoaderCircle,
} from 'lucide-react';
import {
  componentCount,
  moveBlock,
  patchBlock,
  withPictureIds,
  blockSchema,
  messageProblem,
  type Block,
  type ChildBlock,
  type Picture,
} from '../shared/blocks.js';
import { uploadMedia } from './api.js';

const labels = {
  container: 'Контейнер',
  text: 'Текст',
  separator: 'Разделитель',
  section: 'Секция',
  gallery: 'Медиа',
  actions: 'Ряд кнопок',
  file: 'Файл',
};
const icons = {
  container: Box,
  text: AlignLeft,
  separator: Minus,
  section: List,
  gallery: Image,
  actions: MousePointer2,
  file: File,
};
const hints = {
  container: 'Группа блоков с цветной полосой и спойлером',
  text: 'Текст с форматированием Markdown',
  separator: 'Линия или отступ между блоками',
  section: 'Текст с миниатюрой или кнопкой справа',
  gallery: 'До 10 изображений по ссылке или с компьютера',
  actions: 'До 5 кнопок со ссылками',
  file: 'Прикрепить документ к сообщению',
};
const picture = (): Picture => ({ id: crypto.randomUUID(), url: '', description: '', spoiler: false });
export function makeBlock(type: Block['type']): Block {
  const id = crypto.randomUUID();
  switch (type) {
    case 'container':
      return { id, type, color: '#5865f2', spoiler: false, children: [] };
    case 'text':
      return { id, type, content: 'Текст с Markdown…' };
    case 'separator':
      return { id, type, divider: true, spacing: 'small' };
    case 'gallery':
      return { id, type, items: [] };
    case 'section':
      return { id, type, texts: ['Текст секции'], accessory: { type: 'thumbnail', ...picture() } };
    case 'actions':
      return { id, type, buttons: [] };
    case 'file':
      return { id, type, url: '', name: '', spoiler: false };
  }
}

export function MarkdownEditor({
  value,
  onChange,
  label = 'Содержание',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  function format(before: string, after = before) {
    const input = ref.current!;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selection = value.slice(start, end) || 'текст';
    onChange(value.slice(0, start) + before + selection + after + value.slice(end));
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + before.length, start + before.length + selection.length);
    });
  }
  const tools = [
    { name: 'Жирный (Ctrl+B)', icon: Bold, before: '**' },
    { name: 'Курсив (Ctrl+I)', icon: Italic, before: '*' },
    { name: 'Подчёркивание', icon: Underline, before: '__' },
    { name: 'Зачёркнутый', icon: Strikethrough, before: '~~' },
    { name: 'Код', icon: Code2, before: '`' },
    { name: 'Блок кода', icon: Braces, before: '\n```\n', after: '\n```\n' },
    { name: 'Спойлер', icon: EyeOff, before: '||' },
    { name: 'Цитата', icon: Quote, before: '\n> ', after: '' },
    { name: 'Заголовок', icon: Heading, before: '\n## ', after: '' },
    { name: 'Список', icon: List, before: '\n- ', after: '' },
    { name: 'Ссылка (Ctrl+K)', icon: Link, before: '[', after: '](https://example.com)' },
  ];
  return (
    <div className="markdown-editor">
      <div className="format-toolbar" role="toolbar" aria-label="Форматирование текста">
        {tools.map((tool) => (
          <button
            key={tool.name}
            type="button"
            title={tool.name}
            aria-label={tool.name}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format(tool.before, tool.after)}
          >
            <tool.icon size={16} />
          </button>
        ))}
      </div>
      <textarea
        ref={ref}
        aria-label={label}
        value={value}
        maxLength={30000}
        placeholder="Текст с Markdown…"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey) {
            const tool =
              event.key.toLowerCase() === 'b'
                ? tools[0]
                : event.key.toLowerCase() === 'i'
                  ? tools[1]
                  : event.key.toLowerCase() === 'k'
                    ? tools[10]
                    : null;
            if (tool) {
              event.preventDefault();
              format(tool.before, tool.after);
            }
          }
        }}
      />
      <div className="text-count">{value.length.toLocaleString('ru')} символов</div>
    </div>
  );
}

function UploadButton({
  kind,
  onUpload,
}: {
  kind: 'image' | 'file';
  onUpload: (url: string, name: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="upload-control">
      <input
        hidden
        ref={ref}
        type="file"
        accept={
          kind === 'image'
            ? 'image/png,image/jpeg,image/gif,image/webp'
            : '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.zip,.docx'
        }
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setError('');
          setLoading(true);
          try {
            const data = await uploadMedia(file, kind);
            onUpload(data.url, data.name);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Ошибка загрузки');
          } finally {
            setLoading(false);
            event.target.value = '';
          }
        }}
      />
      <button type="button" className="upload-button" disabled={loading} onClick={() => ref.current?.click()}>
        {loading ? <LoaderCircle size={17} className="spinning" /> : <Upload size={17} />}
        {loading ? 'Загрузка…' : kind === 'image' ? 'Загрузить изображение' : 'Выбрать файл'}
      </button>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
function PictureInput({
  value,
  onChange,
  onUpload,
}: {
  value: Picture;
  onChange: (value: Picture) => void;
  onUpload: (url: string) => void;
}) {
  return (
    <div className="picture-input">
      {value.url && (
        <div className="image-input-preview">
          <img
            src={value.url}
            loading="lazy"
            decoding="async"
            alt={value.description || 'Выбранное изображение'}
            referrerPolicy="no-referrer"
          />
        </div>
      )}
      <UploadButton kind="image" onUpload={onUpload} />
      <label>
        Или HTTPS-ссылка
        <input
          aria-label="Ссылка на изображение"
          type="url"
          placeholder="https://…"
          value={value.url.startsWith('/api/media/') ? '' : value.url}
          onChange={(event) => onChange({ ...value, url: event.target.value })}
        />
      </label>
      {value.url.startsWith('/api/media/') && <small>Изображение загружено и сохранено на сервере</small>}
      <label>
        Описание изображения
        <input
          value={value.description}
          placeholder="Для чего это изображение"
          maxLength={300}
          onChange={(event) => onChange({ ...value, description: event.target.value })}
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value.spoiler}
          onChange={(event) => onChange({ ...value, spoiler: event.target.checked })}
        />
        Скрыть под спойлер
      </label>
    </div>
  );
}

function Palette({ nested, onAdd }: { nested: boolean; onAdd: (type: Block['type']) => void }) {
  return (
    <div className="block-palette">
      {(Object.keys(labels) as Block['type'][])
        .filter((type) => !nested || type !== 'container')
        .map((type) => {
          const Icon = icons[type];
          return (
            <button
              type="button"
              className={'palette-item kind-' + type}
              aria-label={'Добавить блок: ' + labels[type]}
              key={type}
              title={hints[type]}
              onClick={() => onAdd(type)}
            >
              <span className="palette-icon">
                <Icon size={19} />
              </span>
              <span>
                <strong>{labels[type]}</strong>
                {type === 'container' && <small>{hints[type]}</small>}
              </span>
              <Plus size={14} className="palette-plus" />
            </button>
          );
        })}
    </div>
  );
}

export function BlockEditor({
  blocks: inputBlocks,
  onChange,
  nested = false,
  parentId = null,
  onMoveBlock,
  onPatchBlock,
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  nested?: boolean;
  parentId?: string | null;
  onMoveBlock?: (id: string, parent: string | null, index: number) => void;
  onPatchBlock?: (id: string, transform: (block: Block) => Block) => void;
}) {
  const blocks = useMemo(() => withPictureIds(inputBlocks), [inputBlocks]);
  const latest = useRef({ blocks, onChange });
  latest.current = { blocks, onChange };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const patch =
    onPatchBlock ||
    ((id: string, transform: (block: Block) => Block) => {
      if (!mounted.current) return;
      const { blocks, onChange } = latest.current;
      const next = patchBlock(blocks, id, transform);
      if (next !== blocks) onChange(next);
    });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const dragMove =
    onMoveBlock ||
    ((id: string, parent: string | null, index: number) => onChange(moveBlock(blocks, id, parent, index)));
  const update = (index: number, block: Block) =>
    onChange(blocks.map((item, i) => (i === index ? block : item)));
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || to >= blocks.length) return;
    const next = [...blocks];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next);
  };
  const insert = (index: number, type: Block['type']) => {
    const next = [...blocks];
    const block = makeBlock(type);
    if (block.type === 'gallery') block.items = [picture()];
    next.splice(index + 1, 0, block);
    onChange(next);
  };
  function drop(event: DragEvent, index: number) {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData('text/plain');
    dragMove(id, parentId, index);
    setDragging(null);
  }
  return (
    <div className={'block-builder ' + (nested ? 'nested-builder' : '')}>
      {!nested && (
        <div className="builder-label">
          <Box size={16} />
          <strong>КОМПОНЕНТЫ V2</strong>
          <span className={'component-counter ' + (componentCount(blocks) > 40 ? 'over-limit' : '')}>
            {componentCount(blocks)} / 40
          </span>
        </div>
      )}
      {blocks.map((block, index) => {
        const Icon = icons[block.type];
        const closed = collapsed.has(block.id);
        return (
          <section
            key={block.id}
            className={'block-card kind-' + block.type + (dragging === block.id ? ' dragging' : '')}
            data-block-id={block.id}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDrop={(event) => drop(event, index)}
          >
            <div className="block-heading">
              <span
                className="drag-handle"
                draggable
                onDragStart={(event) => {
                  event.stopPropagation();
                  event.dataTransfer.setData('text/plain', block.id);
                  setDragging(block.id);
                }}
                onDragEnd={() => setDragging(null)}
                title="Перетащить блок"
              >
                <GripVertical size={16} />
              </span>
              <button
                className="block-collapse"
                type="button"
                aria-expanded={!closed}
                aria-label={(closed ? 'Развернуть ' : 'Свернуть ') + labels[block.type]}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (closed) next.delete(block.id);
                    else next.add(block.id);
                    return next;
                  })
                }
              >
                <Icon size={16} />
                <strong>{labels[block.type]}</strong>
                <ChevronDown size={14} className={closed ? 'closed' : ''} />
              </button>
              <div className="block-tools">
                <button
                  title="Поднять блок"
                  aria-label="Поднять блок"
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  title="Опустить блок"
                  aria-label="Опустить блок"
                  disabled={index === blocks.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  title="Дублировать блок"
                  aria-label="Дублировать блок"
                  onClick={() => {
                    const clone = structuredClone(block);
                    clone.id = crypto.randomUUID();
                    if (clone.type === 'container')
                      clone.children = clone.children.map((child) => ({ ...child, id: crypto.randomUUID() }));
                    const next = [...blocks];
                    next.splice(index + 1, 0, clone);
                    onChange(next);
                  }}
                >
                  <Copy size={14} />
                </button>
                <button
                  className="delete-block"
                  title="Удалить блок"
                  aria-label="Удалить блок"
                  onClick={() => onChange(blocks.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            {!closed && (
              <div className="block-content">
                {block.type === 'text' && (
                  <>
                    <MarkdownEditor
                      value={block.content}
                      onChange={(content) => update(index, { ...block, content })}
                    />
                    <button className="inline-add" type="button" onClick={() => insert(index, 'gallery')}>
                      <Image size={14} />
                      Изображение под этим пунктом
                    </button>
                  </>
                )}
                {block.type === 'separator' && (
                  <div className="separator-options">
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={block.divider}
                        onChange={(event) => update(index, { ...block, divider: event.target.checked })}
                      />
                      Показать линию
                    </label>
                    <label>
                      Отступ
                      <select
                        value={block.spacing}
                        onChange={(event) =>
                          update(index, { ...block, spacing: event.target.value as 'small' | 'large' })
                        }
                      >
                        <option value="small">Малый</option>
                        <option value="large">Большой</option>
                      </select>
                    </label>
                  </div>
                )}
                {block.type === 'container' && (
                  <>
                    <div className="container-options">
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={block.spoiler}
                          onChange={(event) => update(index, { ...block, spoiler: event.target.checked })}
                        />
                        Спойлер
                      </label>
                      <label className="color-field">
                        Цвет полосы
                        <input
                          type="color"
                          aria-label="Цвет контейнера"
                          value={block.color}
                          onChange={(event) => update(index, { ...block, color: event.target.value })}
                        />
                        <code>{block.color}</code>
                      </label>
                    </div>
                    <BlockEditor
                      nested
                      parentId={block.id}
                      onMoveBlock={dragMove}
                      onPatchBlock={patch}
                      blocks={block.children}
                      onChange={(children) => update(index, { ...block, children: children as ChildBlock[] })}
                    />
                  </>
                )}
                {block.type === 'gallery' && (
                  <>
                    <div className="gallery-label">
                      Изображения <span>{block.items.length} / 10</span>
                    </div>
                    {block.items.map((item, itemIndex) => (
                      <div className="gallery-item-editor" key={item.id}>
                        <div className="item-header">
                          <span>Изображение {itemIndex + 1}</span>
                          <button
                            type="button"
                            aria-label="Удалить изображение"
                            onClick={() =>
                              update(index, {
                                ...block,
                                items: block.items.filter((_, i) => i !== itemIndex),
                              })
                            }
                          >
                            <X size={15} />
                          </button>
                        </div>
                        <PictureInput
                          value={item}
                          onUpload={(url) =>
                            patch(block.id, (current) =>
                              current.type === 'gallery'
                                ? {
                                    ...current,
                                    items: current.items.map((picture) =>
                                      picture.id === item.id ? { ...picture, url } : picture,
                                    ),
                                  }
                                : current,
                            )
                          }
                          onChange={(value) =>
                            update(index, {
                              ...block,
                              items: block.items.map((item, i) => (i === itemIndex ? value : item)),
                            })
                          }
                        />
                      </div>
                    ))}
                    <button
                      className="upload-button"
                      type="button"
                      disabled={block.items.length >= 10}
                      onClick={() => update(index, { ...block, items: [...block.items, picture()] })}
                    >
                      <Plus size={16} />
                      Добавить изображение
                    </button>
                  </>
                )}
                {block.type === 'section' && (
                  <>
                    <div className="section-texts">
                      {block.texts.map((value, i) => (
                        <div key={i}>
                          <MarkdownEditor
                            label={'Текст секции ' + (i + 1)}
                            value={value}
                            onChange={(value) =>
                              update(index, {
                                ...block,
                                texts: block.texts.map((text, j) => (i === j ? value : text)),
                              })
                            }
                          />
                          {block.texts.length > 1 && (
                            <button
                              className="inline-add"
                              onClick={() =>
                                update(index, { ...block, texts: block.texts.filter((_, j) => i !== j) })
                              }
                            >
                              Убрать текст
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        className="inline-add"
                        disabled={block.texts.length >= 3}
                        onClick={() => update(index, { ...block, texts: [...block.texts, 'Ещё один текст'] })}
                      >
                        <Plus size={14} />
                        Добавить текст
                      </button>
                    </div>
                    <div className="accessory-editor">
                      <label>
                        Элемент справа
                        <select
                          value={block.accessory.type}
                          onChange={(event) =>
                            update(index, {
                              ...block,
                              accessory:
                                event.target.value === 'thumbnail'
                                  ? { type: 'thumbnail', ...picture() }
                                  : {
                                      type: 'link',
                                      id: crypto.randomUUID(),
                                      label: 'Подробнее',
                                      url: 'https://example.com',
                                    },
                            })
                          }
                        >
                          <option value="thumbnail">Миниатюра</option>
                          <option value="link">Кнопка-ссылка</option>
                        </select>
                      </label>
                      {block.accessory.type === 'thumbnail' ? (
                        <PictureInput
                          value={block.accessory}
                          onUpload={(url) =>
                            patch(block.id, (current) =>
                              current.type === 'section' && current.accessory.type === 'thumbnail'
                                ? { ...current, accessory: { ...current.accessory, url } }
                                : current,
                            )
                          }
                          onChange={(value) =>
                            update(index, { ...block, accessory: { type: 'thumbnail', ...value } })
                          }
                        />
                      ) : (
                        <LinkEditor
                          value={block.accessory}
                          onChange={(accessory) =>
                            update(index, { ...block, accessory: { type: 'link', ...accessory } })
                          }
                        />
                      )}
                    </div>
                  </>
                )}
                {block.type === 'actions' && (
                  <>
                    {block.buttons.map((value, i) => (
                      <div key={value.id} className="link-item">
                        {'action' in value ? (
                          <label className="builtin-button-editor">
                            {value.action === 'ticket' ? 'Кнопка создания тикета' : 'Кнопка открытия правил'}
                            <input
                              value={value.label}
                              maxLength={80}
                              onChange={(event) =>
                                update(index, {
                                  ...block,
                                  buttons: block.buttons.map((item, j) =>
                                    j === i ? { ...value, label: event.target.value } : item,
                                  ),
                                })
                              }
                            />
                            <small>
                              {value.action === 'ticket'
                                ? 'Открывает выбор категории обращения'
                                : 'Открывает личное меню Discord / Игра'}
                            </small>
                          </label>
                        ) : (
                          <LinkEditor
                            value={value}
                            onChange={(value) =>
                              update(index, {
                                ...block,
                                buttons: block.buttons.map((button, j) => (i === j ? value : button)),
                              })
                            }
                          />
                        )}
                        <button
                          className="icon-button danger"
                          aria-label="Удалить кнопку"
                          onClick={() =>
                            update(index, { ...block, buttons: block.buttons.filter((_, j) => i !== j) })
                          }
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="upload-button"
                      disabled={block.buttons.length >= 5}
                      onClick={() =>
                        update(index, {
                          ...block,
                          buttons: [
                            ...block.buttons,
                            { id: crypto.randomUUID(), label: 'Подробнее', url: 'https://example.com' },
                          ],
                        })
                      }
                    >
                      <Plus size={16} />
                      Добавить ссылку <small>{block.buttons.length}/5</small>
                    </button>
                    <button
                      className="upload-button rules-button-add"
                      disabled={block.buttons.length >= 5}
                      onClick={() =>
                        update(index, {
                          ...block,
                          buttons: [
                            ...block.buttons,
                            { id: crypto.randomUUID(), label: 'Читать правила', action: 'rules' },
                          ],
                        })
                      }
                    >
                      <Plus size={16} />
                      Кнопка «Читать правила»
                    </button>
                    <button
                      className="upload-button"
                      disabled={block.buttons.length >= 5}
                      onClick={() =>
                        update(index, {
                          ...block,
                          buttons: [
                            ...block.buttons,
                            { id: crypto.randomUUID(), label: 'Создать тикет', action: 'ticket' },
                          ],
                        })
                      }
                    >
                      <Plus size={16} />
                      Кнопка «Создать тикет»
                    </button>
                  </>
                )}
                {block.type === 'file' && (
                  <>
                    {block.name && (
                      <p className="selected-file">
                        <File size={18} />
                        {block.name}
                      </p>
                    )}
                    <UploadButton
                      kind="file"
                      onUpload={(url, name) =>
                        patch(block.id, (current) =>
                          current.type === 'file' ? { ...current, url, name } : current,
                        )
                      }
                    />
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={block.spoiler}
                        onChange={(event) => update(index, { ...block, spoiler: event.target.checked })}
                      />
                      Спойлер
                    </label>
                  </>
                )}
                {!blockSchema.safeParse(block).success && (
                  <p className="inline-error" role="status">
                    {messageProblem({
                      id: 'validation',
                      blocks: [block],
                      silent: false,
                      mentions: { users: false, roles: false, everyone: false },
                    })}
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
      <div
        className="block-drop-zone"
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => drop(event, blocks.length)}
      >
        {nested
          ? 'Перетащите блок сюда, чтобы добавить в контейнер'
          : 'Перетащите блок сюда, чтобы вынести из контейнера'}
      </div>
      <div className="palette-heading">
        <span>
          <Plus size={13} />
          Добавить блок
        </span>
        <span>{componentCount(blocks)} / 40</span>
      </div>
      <Palette nested={nested} onAdd={(type) => onChange([...blocks, makeBlock(type)])} />
    </div>
  );
}
function LinkEditor({
  value,
  onChange,
}: {
  value: { id: string; label: string; url: string };
  onChange: (value: { id: string; label: string; url: string }) => void;
}) {
  return (
    <div className="link-editor">
      <label>
        Надпись
        <input
          value={value.label}
          maxLength={80}
          onChange={(event) => onChange({ ...value, label: event.target.value })}
        />
      </label>
      <label>
        HTTPS-ссылка
        <input
          type="url"
          value={value.url}
          placeholder="https://example.com"
          onChange={(event) => onChange({ ...value, url: event.target.value })}
        />
      </label>
    </div>
  );
}
