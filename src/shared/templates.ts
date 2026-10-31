import { z } from 'zod';
import { blockSchema, uniqueBlockIds, type Block } from './blocks.js';
/** Templates allow a whole URL variable; ordinary rules/messages keep the stricter block schema. */
export const templateUrlPattern = /^\{\{\s*[a-zA-Z][a-zA-Z0-9_.]*\s*\}\}$/;
function sample(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error('Template nesting limit');
  if (Array.isArray(value)) return value.map((item) => sample(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'url' && typeof item === 'string' && templateUrlPattern.test(item)
          ? 'https://example.invalid/template'
          : sample(item, depth + 1),
      ]),
    );
  return value;
}
export const templateBlocksSchema = z
  .array(
    z.custom<Block>((value) => {
      try {
        return blockSchema.safeParse(sample(value)).success;
      } catch {
        return false;
      }
    }, 'Некорректный блок шаблона'),
  )
  .min(1)
  .max(30)
  .refine(uniqueBlockIds, 'Повторяющиеся ID блоков');
