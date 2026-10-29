import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { desc, eq, lt } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  documentSchema,
  type RulesDocument,
  type SessionUser,
  type SettingsInput,
  type Workspace,
} from '../shared/rules.js';
import * as schema from './schema.js';
import { HttpError } from './errors.js';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');

export class Store {
  readonly sqlite: Database.Database;
  readonly db;
  constructor(filename: string, guildId: string, seed: RulesDocument, adminRoleId: string | null = null) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.sqlite = new Database(filename);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY)');
    if (!this.sqlite.prepare('SELECT id FROM migrations WHERE id = 1').get()) {
      this.sqlite.transaction(() => {
        this.sqlite.exec(readFileSync(resolve('migrations/001-initial.sql'), 'utf8'));
        this.sqlite.prepare('INSERT INTO migrations(id) VALUES (1)').run();
      })();
    }
    this.db = drizzle(this.sqlite);
    this.db.transaction((tx) => {
      tx.insert(schema.draft)
        .values({ id: 1, document: documentSchema.parse(seed), version: 1, updatedAt: Date.now() })
        .onConflictDoNothing()
        .run();
      tx.insert(schema.settings).values({ id: 1, guildId, adminRoleId }).onConflictDoNothing().run();
    });
    if (this.getSettings().guildId !== guildId)
      throw new Error(
        'GUILD_ID не совпадает с сервером в базе данных. Используйте отдельную базу для другого сервера.',
      );
  }
  getSettings() {
    return this.db.select().from(schema.settings).get()!;
  }
  getDraft() {
    return this.db.select().from(schema.draft).get()!;
  }
  workspace(): Workspace {
    const current = this.getDraft();
    return {
      document: current.document,
      version: current.version,
      updatedAt: current.updatedAt,
      settings: this.getSettings(),
      revisions: this.db
        .select({
          id: schema.revisions.id,
          actor: schema.revisions.actor,
          createdAt: schema.revisions.createdAt,
        })
        .from(schema.revisions)
        .orderBy(desc(schema.revisions.id))
        .limit(50)
        .all(),
    };
  }
  saveDraft(document: RulesDocument, version: number, actor: string) {
    this.db.transaction((tx) => {
      if (this.getDraft().version !== version)
        throw new HttpError(409, 'Черновик изменён в другой вкладке. Обновите страницу перед сохранением.');
      tx.update(schema.draft)
        .set({ document, version: version + 1, updatedAt: Date.now() })
        .where(eq(schema.draft.id, 1))
        .run();
      tx.insert(schema.audit).values({ actor, action: 'draft.save', createdAt: Date.now() }).run();
    });
    return this.workspace();
  }
  saveSettings(input: SettingsInput, actor: string) {
    this.db.transaction((tx) => {
      tx.update(schema.settings).set(input).where(eq(schema.settings.id, 1)).run();
      tx.insert(schema.audit).values({ actor, action: 'settings.save', createdAt: Date.now() }).run();
    });
  }
  revision(id: number) {
    const row = this.db.select().from(schema.revisions).where(eq(schema.revisions.id, id)).get();
    if (!row) throw new HttpError(404, 'Версия не найдена');
    return row;
  }
  active() {
    const id = this.getSettings().publishedRevision;
    return id ? this.revision(id).document : null;
  }
  commitPublication(document: RulesDocument, actor: string, channelId: string, messageId: string) {
    return this.db.transaction((tx) => {
      const revision = tx
        .insert(schema.revisions)
        .values({ document, actor, createdAt: Date.now() })
        .returning()
        .get();
      tx.update(schema.settings)
        .set({ channelId, messageId, messageChannelId: channelId, publishedRevision: revision.id })
        .where(eq(schema.settings.id, 1))
        .run();
      tx.insert(schema.audit)
        .values({ actor, action: 'publish.' + revision.id, createdAt: Date.now() })
        .run();
      return revision.id;
    });
  }
  createSession(user: SessionUser) {
    this.prune();
    const token = nonce();
    const csrf = nonce();
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    this.db
      .insert(schema.sessions)
      .values({ hash: hash(token), userId: user.id, name: user.name, csrf, expiresAt })
      .run();
    return { token, csrf, expiresAt };
  }
  session(token: string) {
    const session = this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.hash, hash(token)))
      .get();
    return session && session.expiresAt > Date.now() ? session : null;
  }
  deleteSession(token: string) {
    this.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.hash, hash(token)))
      .run();
  }
  createOAuthState() {
    this.prune();
    const state = nonce();
    this.db
      .insert(schema.oauthStates)
      .values({ hash: hash(state), expiresAt: Date.now() + 10 * 60 * 1000 })
      .run();
    return state;
  }
  consumeOAuthState(state: string) {
    const row = this.db
      .delete(schema.oauthStates)
      .where(eq(schema.oauthStates.hash, hash(state)))
      .returning()
      .get();
    return Boolean(row && row.expiresAt > Date.now());
  }
  private prune() {
    this.db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, Date.now())).run();
    this.db.delete(schema.oauthStates).where(lt(schema.oauthStates.expiresAt, Date.now())).run();
  }
  close() {
    this.sqlite.close();
  }
}
