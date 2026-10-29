import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/server/config.js';

const config = loadConfig();
mkdirSync('data/backups', { recursive: true });
const destination = resolve('data/backups/' + new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite');
const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
try {
  await db.backup(destination);
  console.log('Backup saved: ' + destination);
} finally {
  db.close();
}
