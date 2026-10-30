---
name: open-bot-observability
description: 'Maintain Open Bot activity/error logging and Redis batching, diagnose telemetry failures, or implement its Metrics integration. Distinguish shipped logging from planned Prometheus features; use only in cryals/open-bot.'
---

# Open Bot observability

Locate the checkout and read `AGENTS.md` plus `docs/developer/telemetry.md`. Inspect the actual module catalog and endpoint registration before asserting that a Metrics module or `/metrics` exists.

## Choose the mechanism

- Administrative changes: `ActivityService.record(actor, input)` with kind, target, summary and safe before/after/details. UI clicks are observations, not proof of server success.
- Failures: ErrorReporter with a bounded scope/context and a user-visible report ID. Avoid duplicate reports when the common command/API handler already reports the same exception.
- Aggregates: metrics only when implemented/requested. Logs and health checks are not a Prometheus exporter.

## Persistence invariants

Read `activity-queue.ts` and `activity.ts` before changing batching. Producers first persist UUID events in the shared disk outbox. Only Bot consumes; Redis Streams is optional transport. Batch SQLite commit and JSONL persistence precede ACK. Keep UUID deduplication and local fallback when Redis is absent or rejects writes.

Never delete pending outbox entries to clear an error. Inspect oldest pending/corrupt files, disk availability and consumer state without printing private payloads. Rules, sessions, settings and message IDs commit immediately; moving them into the journal changes correctness.

Only supervisor delivers error outbox, preferring LOG_ID with LOG_WEBHOOK fallback. Delivery failures must not recursively generate an identical queue. Account for duplicate delivery after lost acknowledgements; do not promise exactly once.

## Secrets and cardinality

Pass public projections, not raw config/request objects. Add any new credential to redaction before persistence and Discord delivery. Do not log OAuth codes, cookie/Authorization headers or secret-bearing URLs. Do not observe ordinary member messages unless a specifically authorized feature changes that scope.

For a requested metrics implementation, use bounded labels (module/operation/outcome), correct units and explicit Bot/Web aggregation. User/ticket/channel IDs, content and URLs belong outside metric labels. Plan collector cleanup, endpoint access control and dashboard queries matching real exported names.

## Verification

Use existing FakeDiscord/outbox regressions as relevant and within requested validation. A real Redis test uses an explicit isolated TEST_REDIS_URL and disposable UUID key. No Redis means report the integration as skipped; do not start Docker or virtualization to obtain it on a prohibited host. Preserve production queues during diagnosis.
