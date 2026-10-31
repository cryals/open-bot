import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadConfig } from '../src/server/config.js';

const config = loadConfig();
mkdirSync('data/backups', { recursive: true });
const destination = resolve('data/backups/' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(destination, { recursive: true });
const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
try {
  await db.backup(resolve(destination, 'open-bot.sqlite'));
  const uploads = resolve(dirname(config.databasePath), 'uploads');
  if (existsSync(uploads)) await cp(uploads, resolve(destination, 'uploads'), { recursive: true });
  const logs = resolve(dirname(config.databasePath), 'logs');
  if (existsSync(logs)) await cp(logs, resolve(destination, 'logs'), { recursive: true });
  const errors = resolve(dirname(config.databasePath), 'errors');
  if (existsSync(errors)) await cp(errors, resolve(destination, 'errors'), { recursive: true });
  const outbox = resolve(dirname(config.databasePath), 'activity-outbox');
  if (existsSync(outbox)) await cp(outbox, resolve(destination, 'activity-outbox'), { recursive: true });
  const tickets = resolve(dirname(config.databasePath), 'ticket-files');
  if (existsSync(tickets)) await cp(tickets, resolve(destination, 'ticket-files'), { recursive: true });
  const guildBackups = resolve(dirname(config.databasePath), 'guild-backups');
  if (existsSync(guildBackups))
    await cp(guildBackups, resolve(destination, 'guild-backups'), { recursive: true });
  console.log('Backup saved: ' + destination);
} finally {
  db.close();
}
