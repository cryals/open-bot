import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { collectionSchema, messageSchema, messageProblem } from '../shared/blocks.js';
import { snowflake } from '../shared/rules.js';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import { MessagingStore } from './messaging.js';
import { MediaService } from './media.js';
import { customMessage } from './blocks.js';
import { HttpError } from './errors.js';
import type { ActivityService } from './activity.js';

export async function composerRoutes(
  app: FastifyInstance,
  store: Store,
  discord: DiscordPort,
  activity: ActivityService,
) {
  const messages = new MessagingStore(store);
  const media = new MediaService(store);
  const sending = new Set<string>();
  const actor = (request: FastifyRequest) => request.adminSession!.userId;
  const validate = (document: z.infer<typeof collectionSchema>) => {
    for (const message of document.messages) {
      const problem = messageProblem(message);
      if (problem) throw new HttpError(400, problem);
      media.validate(message.blocks);
      media.prepare(customMessage(message));
    }
  };
  await app.register(multipart, { limits: { files: 1, fields: 0, fileSize: 8 * 1024 * 1024 } });
  app.post('/api/media', async (request) => {
    const query = z.object({ kind: z.enum(['image', 'file']).default('image') }).parse(request.query);
    const file = await request.file();
    if (!file) throw new HttpError(400, 'Выберите файл');
    const buffer = await file.toBuffer();
    const result = media.save(buffer, file.filename, query.kind === 'image', actor(request));
    activity.record(request.adminSession!, {
      kind: 'media.upload',
      target: result.url,
      summary: 'Загружен файл: ' + file.filename,
      details: { filename: file.filename, bytes: buffer.length, kind: query.kind },
    });
    return result;
  });
  app.get('/api/media/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { record, buffer } = media.read(id);
    reply
      .type(record.mime)
      .header(
        'Content-Disposition',
        record.mime.startsWith('image/')
          ? 'inline'
          : "attachment; filename*=UTF-8''" + encodeURIComponent(record.original_name),
      );
    return reply.send(buffer);
  });
  app.get('/api/composer', async () => messages.workspace());
  app.put('/api/composer', async (request) => {
    const input = z
      .object({ version: z.number().int().positive(), document: collectionSchema })
      .parse(request.body);
    validate(input.document);
    const before = messages.workspace().draft;
    const result = messages.save(input.document, input.version);
    activity.record(request.adminSession!, {
      kind: 'composer.save',
      target: 'composer',
      summary: 'Сохранён черновик сообщений',
      before,
      after: input.document,
    });
    return result;
  });
  app.post('/api/templates', async (request) => {
    const document = collectionSchema.parse(request.body);
    validate(document);
    messages.template(document);
    activity.record(request.adminSession!, {
      kind: 'template.create',
      target: document.title,
      summary: 'Сохранён шаблон сообщения',
      after: document,
    });
    return messages.workspace();
  });
  app.delete('/api/templates/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const before = messages.workspace().templates.find((template) => template.id === id);
    messages.removeTemplate(id);
    activity.record(request.adminSession!, {
      kind: 'template.delete',
      target: 'template:' + id,
      summary: 'Удалён шаблон сообщения',
      before,
    });
    return messages.workspace();
  });
  app.post('/api/messages/send', async (request) => {
    const input = z
      .object({ requestId: z.string().uuid(), channelId: snowflake, document: collectionSchema })
      .parse(request.body);
    validate(input.document);
    if (sending.has(input.requestId)) throw new HttpError(409, 'Эта отправка уже выполняется');
    const user = actor(request);
    const dispatch = messages.begin(input.requestId, user, input.channelId, input.document);
    sending.add(input.requestId);
    let next = dispatch.next_index;
    try {
      for (; next < input.document.messages.length; next++) {
        const message = input.document.messages[next];
        const messageId = await discord.sendMessage(message, input.channelId, input.requestId + ':' + next);
        messages.advance(input.requestId, user, input.channelId, messageId, message, next);
        activity.record(request.adminSession!, {
          kind: 'message.send',
          target: `channel:${input.channelId}/message:${messageId}`,
          summary: 'Отправлено сообщение от имени бота',
          details: { channelId: input.channelId, messageId, requestId: input.requestId, index: next },
          after: message,
        });
      }
      return messages.workspace();
    } catch (error) {
      activity.record(request.adminSession!, {
        kind: 'message.send_failed',
        target: 'channel:' + input.channelId,
        summary: 'Отправка сообщений прервана',
        details: {
          sent: next,
          total: input.document.messages.length,
          requestId: input.requestId,
          error: error instanceof Error ? error.name : 'Error',
        },
      });
      app.log.warn(
        { sent: next, name: error instanceof Error ? error.name : 'Error' },
        'Message dispatch interrupted',
      );
      throw new HttpError(
        502,
        `Отправлено ${next} из ${input.document.messages.length}. ${error instanceof HttpError ? error.message + '. ' : ''}Повторите отправку без изменения текста, чтобы продолжить.`,
      );
    } finally {
      sending.delete(input.requestId);
    }
  });
  app.put('/api/messages/:id', async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const message = messageSchema.parse(request.body);
    validate({ title: 'Обновление', messages: [message] });
    const sent = messages.sent(id);
    await discord.editMessage(message, sent.channelId, sent.messageId);
    messages.update(id, message, actor(request));
    activity.record(request.adminSession!, {
      kind: 'message.edit',
      target: `channel:${sent.channelId}/message:${sent.messageId}`,
      summary: 'Отредактировано сообщение бота',
      details: { channelId: sent.channelId, messageId: sent.messageId },
      before: sent.message,
      after: message,
    });
    return messages.workspace();
  });
}
