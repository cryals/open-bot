import { z } from 'zod';

const id = z.string().min(1).max(100);
export const localMediaPattern = /^\/api\/media\/([a-f0-9-]{36})$/;
export const httpsUrl = z
  .string()
  .max(1000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Укажите HTTPS-ссылку');
export const mediaUrl = z.union([httpsUrl, z.string().regex(localMediaPattern)]);
const picture = z.object({
  id: id.optional(),
  url: mediaUrl,
  description: z.string().max(300),
  spoiler: z.boolean(),
});
const link = z.object({ id, label: z.string().trim().min(1).max(80), url: httpsUrl });
const text = z.object({ id, type: z.literal('text'), content: z.string().trim().min(1).max(30000) });
const separator = z.object({
  id,
  type: z.literal('separator'),
  divider: z.boolean(),
  spacing: z.enum(['small', 'large']),
});
const gallery = z.object({ id, type: z.literal('gallery'), items: z.array(picture).min(1).max(10) });
const section = z.object({
  id,
  type: z.literal('section'),
  texts: z.array(z.string().trim().min(1).max(3000)).min(1).max(3),
  accessory: z.discriminatedUnion('type', [
    picture.extend({ type: z.literal('thumbnail') }),
    link.extend({ type: z.literal('link') }),
  ]),
});
const actionButton = z.union([
  link,
  z.object({ id, label: z.string().trim().min(1).max(80), action: z.literal('rules') }),
]);
const actions = z.object({ id, type: z.literal('actions'), buttons: z.array(actionButton).min(1).max(5) });
const file = z.object({
  id,
  type: z.literal('file'),
  url: z.string().regex(localMediaPattern, 'Загрузите файл'),
  name: z.string().max(150),
  spoiler: z.boolean(),
});
const child = z.discriminatedUnion('type', [text, separator, gallery, section, actions, file]);
export const blockSchema = z.discriminatedUnion('type', [
  text,
  separator,
  gallery,
  section,
  actions,
  file,
  z.object({
    id,
    type: z.literal('container'),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    spoiler: z.boolean(),
    children: z.array(child).min(1).max(30),
  }),
]);
export type Block = z.infer<typeof blockSchema>;
export type ChildBlock = Exclude<Block, { type: 'container' }>;
export function uniqueBlockIds(blocks: Block[]): boolean {
  const ids = blocks.flatMap((block) =>
    block.type === 'container' ? [block.id, ...block.children.map((child) => child.id)] : [block.id],
  );
  return new Set(ids).size === ids.length;
}
/** Give older galleries stable item identities when they enter the editor. */
export function withPictureIds(blocks: Block[]): Block[] {
  let changed = false;
  const next = blocks.map((block): Block => {
    if (block.type === 'gallery' && block.items.some((item) => !item.id)) {
      changed = true;
      return {
        ...block,
        items: block.items.map((item, index) =>
          item.id ? item : { ...item, id: `${block.id.slice(0, 80)}:image:${index}` },
        ),
      };
    }
    if (block.type === 'container') {
      const children = withPictureIds(block.children) as ChildBlock[];
      if (children !== block.children) {
        changed = true;
        return { ...block, children };
      }
    }
    return block;
  });
  return changed ? next : blocks;
}
export function patchBlock(blocks: Block[], targetId: string, transform: (block: Block) => Block): Block[] {
  let changed = false;
  const next = blocks.map((block): Block => {
    let updated = block;
    if (block.id === targetId) updated = transform(block);
    else if (block.type === 'container') {
      const children = patchBlock(block.children, targetId, transform) as ChildBlock[];
      if (children !== block.children) updated = { ...block, children };
    }
    if (updated !== block) changed = true;
    return updated;
  });
  return changed ? next : blocks;
}
export function moveBlock(
  blocks: Block[],
  sourceId: string,
  parentId: string | null,
  targetIndex: number,
): Block[] {
  const next = structuredClone(blocks);
  let sourceList: Block[] = next;
  let sourceIndex = next.findIndex((block) => block.id === sourceId);
  if (sourceIndex < 0)
    for (const block of next)
      if (block.type === 'container') {
        const index = block.children.findIndex((child) => child.id === sourceId);
        if (index >= 0) {
          sourceList = block.children;
          sourceIndex = index;
          break;
        }
      }
  if (sourceIndex < 0) return blocks;
  const source = sourceList[sourceIndex];
  const parent = parentId ? next.find((block) => block.id === parentId) : null;
  if (parentId && (!parent || parent.type !== 'container' || source.type === 'container')) return blocks;
  const targetList: Block[] = parent && parent.type === 'container' ? parent.children : next;
  if (sourceList === targetList && sourceIndex < targetIndex) targetIndex--;
  sourceList.splice(sourceIndex, 1);
  targetList.splice(Math.max(0, Math.min(targetIndex, targetList.length)), 0, source);
  return next;
}
export type Picture = z.infer<typeof picture>;
export const messageSchema = z.object({
  id,
  blocks: z.array(blockSchema).min(1).max(40).refine(uniqueBlockIds, 'ID блоков должны быть уникальны'),
  silent: z.boolean(),
  mentions: z.object({ users: z.boolean(), roles: z.boolean(), everyone: z.boolean() }),
});
export type BotMessage = z.infer<typeof messageSchema>;
export const collectionSchema = z.object({
  title: z.string().trim().min(1).max(100),
  messages: z
    .array(messageSchema)
    .min(1)
    .max(10)
    .refine(
      (messages) => new Set(messages.map((message) => message.id)).size === messages.length,
      'ID сообщений должны быть уникальны',
    ),
});
export type MessageCollection = z.infer<typeof collectionSchema>;
export const emptyMessage = (): BotMessage => ({
  id: crypto.randomUUID(),
  blocks: [{ id: crypto.randomUUID(), type: 'text', content: 'Текст сообщения' }],
  silent: false,
  mentions: { users: false, roles: false, everyone: false },
});
export const emptyCollection = (): MessageCollection => ({
  title: 'Новый шаблон',
  messages: [emptyMessage()],
});

export function componentCount(blocks: Block[]): number {
  return blocks.reduce(
    (sum, block) =>
      sum +
      (block.type === 'container'
        ? 1 + componentCount(block.children)
        : block.type === 'section'
          ? 2 + block.texts.length
          : block.type === 'actions'
            ? 1 + block.buttons.length
            : 1),
    0,
  );
}
export function blockText(block: Block): string {
  switch (block.type) {
    case 'text':
      return block.content;
    case 'section':
      return block.texts.join('\n\n');
    case 'container':
      return block.children.map(blockText).filter(Boolean).join('\n\n');
    default:
      return '';
  }
}
export function mediaRefs(blocks: Block[]): string[] {
  return [
    ...new Set(
      blocks
        .flatMap((block) => {
          switch (block.type) {
            case 'container':
              return mediaRefs(block.children);
            case 'gallery':
              return block.items.map((item) => item.url);
            case 'section':
              return block.accessory.type === 'thumbnail' ? [block.accessory.url] : [];
            case 'file':
              return [block.url];
            default:
              return [];
          }
        })
        .filter((url) => localMediaPattern.test(url)),
    ),
  ];
}
export function messageProblem(message: BotMessage): string | null {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) {
    const path = parsed.error.issues[0].path.join('.');
    if (path.includes('items')) return 'Добавьте изображения и заполните ссылки в галерее';
    if (path.includes('accessory')) return 'Укажите миниатюру или кнопку-ссылку для секции';
    if (path.includes('buttons')) return 'Добавьте кнопки и заполните их надписи и ссылки';
    if (path.includes('children')) return 'Заполните блоки внутри контейнера';
    if (path.includes('url')) return 'Загрузите файл или укажите корректную HTTPS-ссылку';
    if (path.includes('content') || path.includes('texts')) return 'Текст блока не должен быть пустым';
    return 'Добавьте и заполните блоки сообщения';
  }
  if (componentCount(message.blocks) > 40) return 'В сообщении больше 40 компонентов';
  if (message.blocks.map(blockText).join('\n').length > 3800)
    return 'Слишком много текста. Перенесите часть в следующее сообщение.';
  if (new TextEncoder().encode(JSON.stringify(message.blocks)).length > 8000)
    return 'Сообщение слишком большое. Уменьшите число блоков или ссылок.';
  if (mediaRefs(message.blocks).length > 10) return 'В одном сообщении можно отправить не более 10 файлов';
  return null;
}
export type SentMessage = {
  id: number;
  version: number;
  channelId: string;
  messageId: string;
  message: BotMessage;
  actor: string;
  createdAt: number;
};
export type ComposerWorkspace = {
  draft: MessageCollection;
  version: number;
  templates: { id: string; title: string; document: MessageCollection }[];
  history: SentMessage[];
};
