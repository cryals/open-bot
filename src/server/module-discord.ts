import type { APIMessageTopLevelComponent } from 'discord.js';
import type { Block, BotMessage } from '../shared/blocks.js';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import { customMessage } from './blocks.js';
import { MediaService } from './media.js';
import { restPort } from './module-http.js';
import { HttpError } from './errors.js';
import { hash } from './store.js';
export type DeliveryOptions = Pick<BotMessage, 'silent' | 'mentions'>;
export function prepareBlocks(
  store: Store,
  blocks: Block[],
  extra: APIMessageTopLevelComponent[],
  nonce: string,
  messageId?: string,
  mentionRole?: string | null,
  delivery?: DeliveryOptions,
) {
  const payload = customMessage({
    id: 'module',
    blocks,
    silent: delivery?.silent ?? true,
    mentions: delivery?.mentions ?? { users: false, roles: false, everyone: false },
  });
  const media = new MediaService(store).prepare(payload);
  const body = {
    flags: payload.flags,
    components: [...media.components, ...extra],
    allowed_mentions: {
      parse: (['users', 'roles', 'everyone'] as const).filter((kind) => delivery?.mentions[kind]),
      ...(delivery?.mentions.roles ? {} : { roles: mentionRole ? [mentionRole] : [] }),
    },
    ...(messageId ? {} : { nonce: hash(nonce).slice(0, 24), enforce_nonce: true }),
    attachments: media.files.map((file, index) => ({ id: index, filename: file.name })),
  };
  const count = (value: unknown): number =>
    !value || typeof value !== 'object'
      ? 0
      : Array.isArray(value)
        ? value.reduce((sum, child) => sum + count(child), 0)
        : ('type' in value ? 1 : 0) +
          Object.values(value).reduce<number>((sum, child) => sum + count(child), 0);
  if (count(body.components) > 40 || Buffer.byteLength(JSON.stringify(body), 'utf8') > 9500)
    throw new HttpError(400, 'Панель слишком большая с учётом служебных кнопок');
  const request = {
    body,
    files: media.files.map((file) => ({ name: file.name, data: file.attachment })),
    signal: AbortSignal.timeout(15000),
  };
  return request;
}
export async function sendBlocks(
  discord: DiscordPort,
  store: Store,
  channel: string,
  blocks: Block[],
  extra: APIMessageTopLevelComponent[],
  nonce: string,
  messageId?: string,
  mentionRole?: string | null,
  delivery?: DeliveryOptions,
): Promise<string> {
  const request = prepareBlocks(store, blocks, extra, nonce, messageId, mentionRole, delivery);
  const rest = restPort(discord);
  let response: unknown;
  try {
    response = messageId
      ? await rest.patch(`/channels/${channel}/messages/${messageId}`, request)
      : await rest.post(`/channels/${channel}/messages`, request);
  } catch (error) {
    if (messageId && (error as { code?: number }).code === 10008)
      return sendBlocks(discord, store, channel, blocks, extra, nonce, undefined, mentionRole, delivery);
    throw error;
  }
  return (response as { id: string }).id;
}
