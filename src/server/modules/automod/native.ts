import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { automodSchema } from '../../../shared/community.js';
import { HttpError } from '../../errors.js';
type AutoModRule = z.infer<typeof automodSchema>['rules'][number];

export const nativeSignature = (enabled: boolean, rule: AutoModRule) =>
  createHash('sha256')
    .update(JSON.stringify([enabled, rule]))
    .digest('hex');

/** Shared by configuration validation and the synchronizer, before native API mutations. */
export function nativeTrigger(rule: AutoModRule) {
  if (rule.roles.length || rule.exceptRoles.length > 20 || rule.exceptChannels.length > 50)
    throw new HttpError(400, 'Недопустимые ограничения ролей/каналов Native AutoMod; используйте режим бота');
  if (!rule.observe && ['notify', 'review'].includes(rule.action))
    throw new HttpError(400, 'Native блокирует сообщение; для notify/review используйте режим бота');
  if (rule.filter === 'mentions') {
    if (!Number.isInteger(rule.threshold) || rule.threshold > 50)
      throw new HttpError(400, 'Порог Native mentions должен быть целым числом от 1 до 50');
    return { mention_total_limit: rule.threshold };
  }
  if (rule.filter === 'invites') {
    if (rule.allowlist.length) throw new HttpError(400, 'Для исключений инвайтов используйте режим бота');
    return { keyword_filter: ['*discord.gg/*', '*discord.com/invite/*', '*discordapp.com/invite/*'] };
  }
  if (rule.filter !== 'words') throw new HttpError(400, 'Native поддерживает words, invites и mentions');
  const keywords = rule.values.map((value) => (rule.wholeWords ? value : `*${value}*`));
  if (
    !keywords.length ||
    rule.values.some((value) => !value.trim() || value.includes('*')) ||
    keywords.some((value) => value.length > 60)
  )
    throw new HttpError(400, 'Native: непустые ключевые слова без *, до 60 символов вместе с обрамлением');
  return { keyword_filter: keywords };
}
