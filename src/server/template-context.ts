import type { Block, ChildBlock } from '../shared/blocks.js';
import { blockSchema, mediaUrl } from '../shared/blocks.js';
import { templateUrlPattern } from '../shared/templates.js';
import { HttpError } from './errors.js';
export type TemplateContext = Record<string, string | number>;
export function renderVariables(text: string, context: TemplateContext) {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(context, key)) throw new HttpError(400, 'Неизвестная переменная шаблона: ' + key);
    return String(context[key]).replace(/@/g, '@\u200b');
  });
}
export function renderTemplate(blocks: Block[], context: TemplateContext): Block[] {
  const url = (value: string) => {
    if (!templateUrlPattern.test(value)) return value;
    const name = value.slice(2, -2).trim();
    if (!Object.hasOwn(context, name)) throw new HttpError(400, 'Неизвестная URL-переменная: ' + name);
    return mediaUrl.parse(String(context[name]));
  };
  const visit = (block: Block): Block => {
    if (block.type === 'text') return { ...block, content: renderVariables(block.content, context) };
    if (block.type === 'container')
      return { ...block, children: block.children.map((child) => visit(child) as ChildBlock) };
    if (block.type === 'section')
      return {
        ...block,
        texts: block.texts.map((text) => renderVariables(text, context)),
        accessory: { ...block.accessory, url: url(block.accessory.url) },
      };
    if (block.type === 'gallery')
      return { ...block, items: block.items.map((item) => ({ ...item, url: url(item.url) })) };
    if (block.type === 'actions')
      return {
        ...block,
        buttons: block.buttons.map((button) =>
          'url' in button ? { ...button, url: url(button.url) } : button,
        ),
      };
    return block;
  };
  return blocks.map((block) => blockSchema.parse(visit(block)));
}
