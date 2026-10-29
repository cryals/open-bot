import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localMediaPattern, type Block } from '../shared/blocks.js';
import type { Store } from './store.js';
import { HttpError } from './errors.js';

type MediaRecord = { id: string; filename: string; original_name: string; mime: string; size: number };
export class MediaService {
  readonly root: string;
  constructor(
    private store: Store,
    root?: string,
  ) {
    this.root =
      root ||
      (store.sqlite.name === ':memory:'
        ? resolve('output/testuploads')
        : resolve(dirname(store.sqlite.name), 'uploads'));
  }
  get(id: string): MediaRecord {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, 'Файл не найден');
    const record = this.store.sqlite.prepare('SELECT * FROM media WHERE id = ?').get(id) as
      MediaRecord | undefined;
    if (!record) throw new HttpError(404, 'Файл не найден');
    return record;
  }
  save(buffer: Buffer, name: string, image: boolean, actor: string) {
    if (!buffer.length || buffer.length > 8 * 1024 * 1024)
      throw new HttpError(400, 'Размер файла: от 1 байта до 8 МБ');
    const head = buffer.subarray(0, 12);
    const kind = head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? ['.png', 'image/png']
      : head[0] === 255 && head[1] === 216 && head[2] === 255
        ? ['.jpg', 'image/jpeg']
        : /^GIF8[79]a/.test(head.toString('ascii'))
          ? ['.gif', 'image/gif']
          : head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP'
            ? ['.webp', 'image/webp']
            : null;
    if (image && !kind) throw new HttpError(400, 'Для изображений поддерживаются PNG, JPEG, GIF и WebP');
    const extension = extname(name).toLowerCase();
    if (!kind && !['.pdf', '.txt', '.md', '.csv', '.json', '.zip', '.docx'].includes(extension))
      throw new HttpError(400, 'Поддерживаются изображения, PDF, TXT, MD, CSV, JSON, ZIP и DOCX');
    const id = randomUUID();
    const filename = id + (kind?.[0] || extension);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(resolve(this.root, filename), buffer, { flag: 'wx' });
    this.store.sqlite
      .prepare(
        'INSERT INTO media (id,filename,original_name,mime,size,actor,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        id,
        filename,
        name.slice(0, 150),
        kind?.[1] || 'application/octet-stream',
        buffer.length,
        actor,
        Date.now(),
      );
    return { id, url: '/api/media/' + id, name: name.slice(0, 150), size: buffer.length };
  }
  read(id: string) {
    const record = this.get(id);
    return { record, buffer: readFileSync(resolve(this.root, record.filename)) };
  }
  validate(blocks: Block[]) {
    for (const block of blocks) {
      if (block.type === 'container') this.validate(block.children);
      const images =
        block.type === 'gallery'
          ? block.items.map((item) => item.url)
          : block.type === 'section' && block.accessory.type === 'thumbnail'
            ? [block.accessory.url]
            : [];
      for (const url of images) {
        const id = localMediaPattern.exec(url)?.[1];
        if (id && !this.get(id).mime.startsWith('image/'))
          throw new HttpError(400, 'Выбранный файл не является изображением');
      }
      if (block.type === 'file') this.get(localMediaPattern.exec(block.url)![1]);
    }
  }
  prepare<T>(base: T): T & { files: { attachment: Buffer; name: string }[] } {
    const json: unknown = JSON.parse(JSON.stringify(base));
    const files = new Map<string, { attachment: Buffer; name: string }>();
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const match = key === 'url' && typeof child === 'string' ? localMediaPattern.exec(child) : null;
        if (match) {
          const { record, buffer } = this.read(match[1]);
          files.set(record.id, { attachment: buffer, name: record.filename });
          (value as Record<string, unknown>)[key] = 'attachment://' + record.filename;
        } else walk(child);
      }
    };
    walk(json);
    if (Buffer.byteLength(JSON.stringify(json)) > 10000)
      throw new HttpError(
        400,
        'Сообщение превышает безопасный размер Discord. Перенесите часть блоков в следующее сообщение.',
      );
    if (
      files.size > 10 ||
      [...files.values()].reduce((sum, file) => sum + file.attachment.length, 0) > 8 * 1024 * 1024
    )
      throw new HttpError(
        400,
        'Суммарный размер вложений одного сообщения не должен превышать 8 МБ (до 10 файлов)',
      );
    return { ...(json as T), files: [...files.values()] };
  }
}
