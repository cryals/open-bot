import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { APIMessage } from 'discord.js';
import type { Config } from '../../config.js';
import type { Store } from '../../store.js';
import { TicketStore } from './store.js';
import { HttpError } from '../../errors.js';
export type ArchivedFile = {
  id: string;
  ticket_id: number;
  message_id: string;
  attachment_id: string;
  scope: string;
  name: string;
  size: number;
  mime: string;
  url: string;
  filename: string | null;
  state: string;
  error: string | null;
  next_at: number;
  attempts: number;
};
type ArchivedMessage = {
  id: string;
  ticket_id: number;
  scope: string;
  author_id: string;
  author_name: string;
  content: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  bot: number;
  snapshot: string;
};
function visibleText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(visibleText).filter(Boolean).join('\n');
  const item = value as Record<string, unknown>;
  if (item.type === 10 && typeof item.content === 'string') return item.content;
  return (
    (typeof item.title === 'string' ? item.title + '\n' : '') +
    (typeof item.description === 'string' ? item.description + '\n' : '') +
    (typeof item.name === 'string' ? item.name + '\n' : '') +
    (typeof item.value === 'string' ? item.value + '\n' : '') +
    visibleText(item.components) +
    visibleText(item.fields)
  );
}
export class TicketArchive {
  readonly root: string;
  private copies = new Map<string, Promise<void>>();
  constructor(
    config: Config,
    private store: Store,
    private tickets: TicketStore,
  ) {
    this.root =
      store.sqlite.name === ':memory:'
        ? resolve('output/test-ticket-files')
        : resolve(dirname(config.databasePath), 'ticket-files');
  }
  async capture(
    ticketId: number,
    scope: 'customer' | 'staff',
    message: Partial<APIMessage> & { id: string },
    kind: 'create' | 'update' | 'delete' = 'create',
  ) {
    this.tickets.get(ticketId);
    const previous = this.store.sqlite.prepare('SELECT * FROM ticket_messages WHERE id=?').get(message.id) as
      ArchivedMessage | undefined;
    if (previous && previous.ticket_id !== ticketId) throw new Error('Message ticket mismatch');
    const snapshot = {
      ...(previous ? JSON.parse(previous.snapshot) : {}),
      ...message,
    } as Partial<APIMessage>;
    const content = [snapshot.content, visibleText(snapshot.components), visibleText(snapshot.embeds)]
      .filter(Boolean)
      .join('\n');
    const historyProjection = (value: Partial<APIMessage>) =>
      JSON.stringify([
        value.content ?? '',
        value.components ?? [],
        value.embeds ?? [],
        (value.attachments ?? []).map(({ id, filename, size, description }) => ({
          id,
          filename,
          size,
          description,
        })),
      ]);
    const changed =
      previous && historyProjection(JSON.parse(previous.snapshot)) !== historyProjection(snapshot);
    const changedAt = Date.now();
    const author = message.author?.id || previous?.author_id || 'unknown';
    this.store.sqlite
      .transaction(() => {
        if (previous && changed && kind !== 'delete')
          this.store.sqlite
            .prepare(
              'INSERT INTO ticket_revisions(message_id,content,changed_at,kind,snapshot) VALUES(?,?,?,?,?)',
            )
            .run(message.id, previous.content, changedAt, 'edit', previous.snapshot);
        if (kind === 'delete' && previous && !previous.deleted_at)
          this.store.sqlite
            .prepare(
              'INSERT INTO ticket_revisions(message_id,content,changed_at,kind,snapshot) VALUES(?,?,?,?,?)',
            )
            .run(message.id, previous.content, changedAt, 'delete', previous.snapshot);
        this.store.sqlite
          .prepare(
            'INSERT INTO ticket_messages(id,ticket_id,scope,author_id,author_name,content,created_at,edited_at,deleted_at,bot,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,edited_at=COALESCE(excluded.edited_at,ticket_messages.edited_at),deleted_at=COALESCE(excluded.deleted_at,ticket_messages.deleted_at),snapshot=excluded.snapshot',
          )
          .run(
            message.id,
            ticketId,
            scope,
            author,
            message.author?.username || previous?.author_name || 'Неизвестно',
            content,
            message.timestamp ? Date.parse(message.timestamp) : previous?.created_at || changedAt,
            message.edited_timestamp ? Date.parse(message.edited_timestamp) : changed ? changedAt : null,
            kind === 'delete' ? changedAt : null,
            message.author?.bot ? 1 : previous?.bot || 0,
            JSON.stringify(snapshot),
          );
        for (const file of message.attachments || []) {
          this.store.sqlite
            .prepare(
              'INSERT INTO ticket_files(id,ticket_id,message_id,attachment_id,scope,name,size,mime,url) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id,attachment_id) DO UPDATE SET url=excluded.url',
            )
            .run(
              randomUUID(),
              ticketId,
              message.id,
              file.id,
              scope,
              file.filename.slice(0, 200),
              file.size,
              file.content_type || 'application/octet-stream',
              file.url,
            );
        }
      })
      .immediate();
    if (kind === 'delete') return;
  }
  async copy(file: ArchivedFile) {
    const pending = this.copies.get(file.id);
    if (pending) return pending;
    const promise = this.copyOnce(file).finally(() => this.copies.delete(file.id));
    this.copies.set(file.id, promise);
    return promise;
  }
  async copyPending() {
    const files = this.store.sqlite
      .prepare(
        "SELECT f.* FROM ticket_files f JOIN tickets t ON t.id=f.ticket_id WHERE f.state!='stored' AND f.next_at<=? AND (t.expires_at IS NULL OR t.expires_at>?) ORDER BY f.rowid LIMIT 2",
      )
      .all(Date.now(), Date.now()) as ArchivedFile[];
    for (const file of files) await this.copy(file);
  }
  private async copyOnce(file: ArchivedFile) {
    const settings = this.tickets.config().document;
    const temp = resolve(this.root, file.id + '.part');
    try {
      const url = new URL(file.url);
      if (
        url.protocol !== 'https:' ||
        !['cdn.discordapp.com', 'media.discordapp.net', 'cdn.discord.com'].includes(url.hostname) ||
        !url.pathname.startsWith('/attachments/')
      )
        throw new Error('Вложение не с Discord CDN');
      if (file.size > settings.maxAttachmentMb * 1024 * 1024)
        throw new Error('Размер вложения превышает лимит архива');
      const usage = (
        this.store.sqlite.prepare('SELECT COALESCE(SUM(size),0) bytes FROM ticket_files').get() as {
          bytes: number;
        }
      ).bytes;
      if (usage > settings.maxArchiveMb * 1024 * 1024) throw new Error('Лимит архива исчерпан');
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Discord CDN: HTTP ' + response.status);
      // Preserve arbitrary attachment bytes, not a decoded UTF-8 string.
      if (!response.body) throw new Error('Пустое вложение');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > settings.maxAttachmentMb * 1024 * 1024)
            throw new Error('Размер вложения превышает лимит архива');
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = Buffer.concat(chunks),
        head = bytes.subarray(0, 12);
      const mime = head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : head[0] === 255 && head[1] === 216 && head[2] === 255
          ? 'image/jpeg'
          : /^GIF8[79]a/.test(head.toString('ascii'))
            ? 'image/gif'
            : head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP'
              ? 'image/webp'
              : 'application/octet-stream';
      await mkdir(this.root, { recursive: true });
      await writeFile(temp, bytes);
      await rename(temp, resolve(this.root, file.id + '.bin'));
      this.store.sqlite
        .prepare("UPDATE ticket_files SET filename=?,size=?,mime=?,state='stored',error=NULL WHERE id=?")
        .run(file.id + '.bin', size, mime, file.id);
    } catch (error) {
      await unlink(temp).catch(() => {});
      this.store.sqlite
        .prepare("UPDATE ticket_files SET state='error',error=?,attempts=attempts+1,next_at=? WHERE id=?")
        .run(
          error instanceof Error ? error.message : 'Ошибка копирования',
          Date.now() + Math.min(300000, 5000 * 2 ** Math.min(file.attempts, 6)),
          file.id,
        );
    }
  }
  async download(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, 'Файл не найден');
    const file = this.store.sqlite.prepare('SELECT * FROM ticket_files WHERE id=?').get(id) as
      ArchivedFile | undefined;
    if (!file || file.state !== 'stored' || !file.filename || file.filename !== file.id + '.bin')
      throw new HttpError(404, 'Файл не сохранён');
    this.tickets.get(file.ticket_id);
    return { file, buffer: await readFile(resolve(this.root, file.filename)) };
  }
  messages(ticketId: number, scope: string, before?: string) {
    this.tickets.get(ticketId);
    const rows = this.store.sqlite
      .prepare(
        'SELECT * FROM ticket_messages WHERE ticket_id=? AND scope=? AND CAST(id AS INTEGER)<CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) DESC LIMIT 101',
      )
      .all(ticketId, scope, before || '9223372036854775807') as ArchivedMessage[];
    return rows.slice(0, 100).map(({ snapshot: _, ...row }) => ({
      ...row,
      revisions: this.store.sqlite
        .prepare('SELECT id,content,changed_at,kind FROM ticket_revisions WHERE message_id=? ORDER BY id')
        .all(row.id),
      files: (
        this.store.sqlite
          .prepare('SELECT * FROM ticket_files WHERE message_id=?')
          .all(row.id) as ArchivedFile[]
      ).map(({ url: _, filename: __, ...file }) => file),
    }));
  }
  async purge(id: number) {
    const ids = this.store.sqlite.prepare('SELECT id FROM ticket_files WHERE ticket_id=?').all(id) as {
      id: string;
    }[];
    await Promise.all(ids.map((file) => this.copies.get(file.id)));
    const files = this.store.sqlite
      .prepare('SELECT id,filename FROM ticket_files WHERE ticket_id=?')
      .all(id) as { id: string; filename: string | null }[];
    for (const file of files) {
      if (file.filename && file.filename === file.id + '.bin')
        await unlink(resolve(this.root, file.filename)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
    }
    this.store.sqlite.prepare('DELETE FROM tickets WHERE id=?').run(id);
  }
}
