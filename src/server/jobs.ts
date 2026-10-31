import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
export type Job = {
  id: string;
  kind: string;
  operation_id: string;
  payload: string;
  state: string;
  due_at: number;
  attempts: number;
  owner: string | null;
};
/** One Bot consumer. Leases preserve work through crashes; handlers own remote reconciliation. */
export class JobStore {
  readonly owner = randomUUID();
  constructor(private store: Store) {}
  enqueue(id: string, kind: string, operation: string, payload: unknown, due = Date.now()) {
    this.store.sqlite
      .prepare(
        'INSERT INTO core_jobs(id,kind,operation_id,payload,due_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .run(id, kind, operation, JSON.stringify(payload), due, Date.now());
  }
  claim(kinds: string[]): Job | undefined {
    if (!kinds.length) return;
    return this.store.sqlite
      .transaction(() => {
        const now = Date.now();
        const row = this.store.sqlite
          .prepare(
            `SELECT * FROM core_jobs WHERE kind IN (${kinds.map(() => '?').join(',')}) AND due_at<=? AND (state='pending' OR (state='running' AND lease_until<?)) ORDER BY due_at LIMIT 1`,
          )
          .get(...kinds, now, now) as Job | undefined;
        if (!row) return;
        this.store.sqlite
          .prepare(
            "UPDATE core_jobs SET state='running',owner=?,lease_until=?,attempts=attempts+1 WHERE id=?",
          )
          .run(this.owner, now + 120000, row.id);
        return { ...row, owner: this.owner, attempts: row.attempts + 1 };
      })
      .immediate();
  }
  finish(job: Job, result: unknown = null) {
    this.store.sqlite
      .prepare(
        "UPDATE core_jobs SET state='done',result=?,lease_until=NULL WHERE id=? AND owner=? AND state='running'",
      )
      .run(JSON.stringify(result), job.id, this.owner);
  }
  fail(job: Job, error: string, retryAt?: number) {
    this.store.sqlite
      .prepare(
        "UPDATE core_jobs SET state=?,result=?,due_at=?,lease_until=NULL WHERE id=? AND owner=? AND state='running'",
      )
      .run(
        retryAt ? 'pending' : 'failed',
        JSON.stringify({ error }),
        retryAt || Date.now(),
        job.id,
        this.owner,
      );
  }
  cancel(id: string) {
    return (
      this.store.sqlite
        .prepare("UPDATE core_jobs SET state='cancelled' WHERE id=? AND state='pending'")
        .run(id).changes > 0
    );
  }
}
export function domainEvent(store: Store, id: string, operation: string, kind: string, payload: unknown) {
  store.sqlite
    .prepare(
      'INSERT INTO domain_events(id,operation_id,kind,payload,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
    )
    .run(id, operation, kind, JSON.stringify(payload), Date.now());
}
