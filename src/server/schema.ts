import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RulesDocument } from '../shared/rules.js';

export const draft = sqliteTable('draft', {
  id: integer('id').primaryKey(),
  document: text('document', { mode: 'json' }).$type<RulesDocument>().notNull(),
  version: integer('version').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id'),
  messageId: text('message_id'),
  messageChannelId: text('message_channel_id'),
  adminRoleId: text('admin_role_id'),
  publishedRevision: integer('published_revision').references(() => revisions.id),
});
export const revisions = sqliteTable('revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  document: text('document', { mode: 'json' }).$type<RulesDocument>().notNull(),
  actor: text('actor').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const sessions = sqliteTable('sessions', {
  hash: text('hash').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  csrf: text('csrf').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
export const oauthStates = sqliteTable('oauth_states', {
  hash: text('hash').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
});
export const audit = sqliteTable('audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  createdAt: integer('created_at').notNull(),
});
