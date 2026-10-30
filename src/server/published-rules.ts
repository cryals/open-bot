import { paginate, type RulesDocument, type ViewPage, type RuleKey } from '../shared/rules.js';
import type { Store } from './store.js';

type Snapshot = { revision: number; document: RulesDocument; pages: Record<RuleKey, ViewPage[]> };
const snapshots = new WeakMap<Store, Snapshot>();

/** Published revisions are immutable. Read the current revision ID on every interaction. */
export function publishedRules(store: Store): Snapshot | null {
  const revision = store.getSettings().publishedRevision;
  if (!revision) return null;
  const previous = snapshots.get(store);
  if (previous?.revision === revision) return previous;
  const document = store.revision(revision).document;
  const snapshot = {
    revision,
    document,
    pages: { discord: paginate(document.rulesets[0]), game: paginate(document.rulesets[1]) },
  };
  snapshots.set(store, snapshot);
  return snapshot;
}
