import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import {
  collectionSchema,
  emptyCollection,
  type BotMessage,
  type ComposerWorkspace,
  type MessageCollection,
  type SentMessage,
} from '../shared/blocks.js';
import { HttpError } from './errors.js';

type HistoryRow = {
  id: number;
  channel_id: string;
  message_id: string;
  document: string;
  actor: string;
  created_at: number;
};
type Dispatch = { id: string; actor: string; channel_id: string; document: string; next_index: number };
export class MessagingStore {
  constructor(private store: Store) {
    store.sqlite
      .prepare('INSERT OR IGNORE INTO composer (id,document,version) VALUES (1,?,1)')
      .run(JSON.stringify(emptyCollection()));
  }
  workspace(): ComposerWorkspace {
    const row = this.store.sqlite.prepare('SELECT * FROM composer WHERE id=1').get() as {
      document: string;
      version: number;
    };
    const templates = this.store.sqlite
      .prepare('SELECT * FROM templates ORDER BY created_at DESC LIMIT 50')
      .all() as { id: string; title: string; document: string }[];
    const history = this.store.sqlite
      .prepare('SELECT * FROM sent_messages ORDER BY created_at DESC,id DESC LIMIT 100')
      .all() as HistoryRow[];
    return {
      draft: collectionSchema.parse(JSON.parse(row.document)),
      version: row.version,
      templates: templates.map((item) => ({ ...item, document: JSON.parse(item.document) })),
      history: history.map(this.mapHistory),
    };
  }
  private mapHistory(row: HistoryRow): SentMessage {
    return {
      id: row.id,
      channelId: row.channel_id,
      messageId: row.message_id,
      message: JSON.parse(row.document),
      actor: row.actor,
      createdAt: row.created_at,
    };
  }
  save(document: MessageCollection, version: number) {
    const changed = this.store.sqlite
      .prepare('UPDATE composer SET document=?,version=version+1 WHERE id=1 AND version=?')
      .run(JSON.stringify(document), version);
    if (!changed.changes)
      throw new HttpError(409, 'Черновик сообщений изменён в другой вкладке. Обновите страницу.');
    return this.workspace();
  }
  template(document: MessageCollection) {
    this.store.sqlite
      .prepare('INSERT INTO templates (id,title,document,created_at) VALUES (?,?,?,?)')
      .run(randomUUID(), document.title, JSON.stringify(document), Date.now());
  }
  removeTemplate(id: string) {
    this.store.sqlite.prepare('DELETE FROM templates WHERE id=?').run(id);
  }
  sent(id: number): SentMessage {
    const row = this.store.sqlite.prepare('SELECT * FROM sent_messages WHERE id=?').get(id) as
      HistoryRow | undefined;
    if (!row) throw new HttpError(404, 'Сообщение не найдено в истории этого бота');
    return this.mapHistory(row);
  }
  update(id: number, message: BotMessage, actor: string) {
    this.store.sqlite
      .prepare('UPDATE sent_messages SET document=?,actor=? WHERE id=?')
      .run(JSON.stringify(message), actor, id);
  }
  begin(id: string, actor: string, channelId: string, document: MessageCollection): Dispatch {
    const serialized = JSON.stringify(document);
    this.store.sqlite
      .prepare(
        'INSERT OR IGNORE INTO dispatches (id,actor,channel_id,document,created_at) VALUES (?,?,?,?,?)',
      )
      .run(id, actor, channelId, serialized, Date.now());
    const row = this.store.sqlite.prepare('SELECT * FROM dispatches WHERE id=?').get(id) as Dispatch;
    if (row.actor !== actor || row.channel_id !== channelId || row.document !== serialized)
      throw new HttpError(409, 'Этот запрос отправки уже использован. Начните новую отправку.');
    return row;
  }
  advance(
    id: string,
    actor: string,
    channelId: string,
    messageId: string,
    message: BotMessage,
    index: number,
  ) {
    this.store.sqlite.transaction(() => {
      this.store.sqlite
        .prepare(
          'INSERT OR IGNORE INTO sent_messages (channel_id,message_id,document,actor,created_at) VALUES (?,?,?,?,?)',
        )
        .run(channelId, messageId, JSON.stringify(message), actor, Date.now());
      this.store.sqlite.prepare('UPDATE dispatches SET next_index=? WHERE id=?').run(index + 1, id);
    })();
  }
}
