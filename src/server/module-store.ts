import type { z } from 'zod';
import type { Store } from './store.js';
import { HttpError } from './errors.js';

export class ModuleStore {
  constructor(readonly store: Store) {}
  get<T>(id: string, schema: z.ZodType<T>, fallback: T): { document: T; version: number } {
    const row = this.store.sqlite.prepare('SELECT document,version FROM module_config WHERE id=?').get(id) as
      { document: string; version: number } | undefined;
    return row
      ? { document: schema.parse(JSON.parse(row.document)), version: row.version }
      : { document: fallback, version: 0 };
  }
  save<T>(id: string, schema: z.ZodType<T>, document: unknown, version: number) {
    const parsed = schema.parse(document);
    this.store.sqlite
      .transaction(() => {
        const row = this.store.sqlite.prepare('SELECT version FROM module_config WHERE id=?').get(id) as
          { version: number } | undefined;
        if ((row?.version || 0) !== version)
          throw new HttpError(409, 'Настройки уже изменены. Обновите страницу.');
        this.store.sqlite
          .prepare(
            'INSERT INTO module_config(id,document,version) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,version=excluded.version',
          )
          .run(id, JSON.stringify(parsed), version + 1);
      })
      .immediate();
    return { document: parsed, version: version + 1 };
  }
}
