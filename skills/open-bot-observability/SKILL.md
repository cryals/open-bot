---
name: open-bot-observability
description: 'Maintain Open Bot audit/error logging, Redis batching and the isolated Prometheus exporter; diagnose worker snapshots, ticket aggregates and Grafana queries in cryals/open-bot.'
---

# Open Bot observability

Locate the checkout and read `AGENTS.md` plus `docs/developer/telemetry.md`. Inspect the actual module catalog and endpoint registration before asserting that a Metrics module or `/metrics` exists.

## Choose the mechanism

- Administrative changes: `ActivityService.record(actor, input)` with kind, target, summary and safe before/after/details. UI clicks are observations, not proof of server success.
- Failures: ErrorReporter with a bounded scope/context and a user-visible report ID. Avoid duplicate reports when the common command/API handler already reports the same exception.
- Aggregates: shared telemetry.ts registry, per-worker SQLite snapshots and a dedicated Metrics worker/port. Do not scrape by calling Discord. Health checks are not successful Prometheus scrapes.

## Persistence invariants

Read `activity-queue.ts` and `activity.ts` before changing batching. Producers first persist UUID events in the shared disk outbox. Only Bot consumes; Redis Streams is optional transport. Batch SQLite commit and JSONL persistence precede ACK. Keep UUID deduplication and local fallback when Redis is absent or rejects writes.

Never delete pending outbox entries to clear an error. Inspect oldest pending/corrupt files, disk availability and consumer state without printing private payloads. Rules, sessions, settings and message IDs commit immediately; moving them into the journal changes correctness.

Only supervisor delivers error outbox, preferring LOG_ID with LOG_WEBHOOK fallback. Delivery failures must not recursively generate an identical queue. Account for duplicate delivery after lost acknowledgements; do not promise exactly once.

## Secrets and cardinality

Pass public projections, not raw config/request objects. Add new credentials to redaction before persistence/delivery, including WATCHDOG_TOKEN_* and METRICS_TOKEN. Do not log OAuth codes, cookie/Authorization headers or secret-bearing URLs. Message history is restricted to explicitly enabled Ticket channels/threads and expires after 180 days. Keep transcript UI under data-no-audit so its content does not leak into permanent activity logs.

Use bounded labels (module/operation/outcome), correct units and explicit Bot/Web/Metrics aggregation. Snapshots update every 10 seconds; exclude stale data after 30 seconds. Ticket totals persist independently of archive deletion; worker counters reset on restart. IDs/content/URLs are not labels. Preserve bearer authentication, dedicated listener and dashboard queries matching exported names.

## Verification

Use existing FakeDiscord/outbox regressions as relevant and within requested validation. A real Redis test uses an explicit isolated TEST_REDIS_URL and disposable UUID key. No Redis means report the integration as skipped; do not start Docker or virtualization to obtain it on a prohibited host. Preserve production queues during diagnosis.
