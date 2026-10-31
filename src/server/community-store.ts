import type { z } from 'zod';
import type { Store } from './store.js';
import { ModuleStore } from './module-store.js';
import { communityDefinitions, type CommunityModuleId } from '../shared/community.js';
import { HttpError } from './errors.js';
const configCache = new WeakMap<Store, Map<string, { document: unknown; version: number; until: number }>>();
export class CommunityStore {
  readonly modules: ModuleStore;
  constructor(readonly store: Store) {
    this.modules = new ModuleStore(store);
  }
  config<K extends CommunityModuleId>(
    id: K,
    fresh = false,
  ): { document: z.infer<(typeof communityDefinitions)[K]['schema']>; version: number } {
    let cache = configCache.get(this.store);
    if (!cache) {
      cache = new Map();
      configCache.set(this.store, cache);
    }
    const cached = cache.get(id);
    if (!fresh && cached && cached.until > Date.now())
      return { document: cached.document, version: cached.version } as never;
    const schema = communityDefinitions[id].schema as z.ZodType;
    const value = this.modules.get(id, schema, schema.parse({}));
    cache.set(id, { ...value, until: Date.now() + 1000 });
    return value as never;
  }
  state<T>(module: string, key: string): T | null {
    const row = this.store.sqlite
      .prepare('SELECT document FROM module_state WHERE module=? AND key=?')
      .get(module, key) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as T) : null;
  }
  set(module: string, key: string, value: unknown) {
    this.store.sqlite
      .prepare(
        'INSERT INTO module_state(module,key,document,updated_at) VALUES(?,?,?,?) ON CONFLICT(module,key) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at',
      )
      .run(module, key, JSON.stringify(value), Date.now());
  }
  save(id: CommunityModuleId, document: unknown, version: number) {
    const schema = communityDefinitions[id].schema as z.ZodType;
    const parsed = schema.parse(document) as Record<string, unknown>;
    for (const key of ['rules', 'panels', 'commands', 'forms', 'boards', 'feeds']) {
      const items = parsed[key] as { id: string }[] | undefined;
      if (items && new Set(items.map((item) => item.id)).size !== items.length)
        throw new HttpError(400, 'Повторяющиеся ID: ' + key);
    }
    const saved = this.modules.save(id, schema, parsed, version);
    configCache.get(this.store)?.delete(id);
    return saved;
  }
}
