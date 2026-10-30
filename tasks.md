# Open Bot — tasks

Implementation approved by the user on 2026-10-29. The MVP is implemented. Editorial questions about the supplied rule text remain for the administrator to review before publishing.

## Phase 0 — design approval

- [x] Review docs/superpowers/specs/2026-10-29-openspace-rules-bot-design.md.
- [x] Confirm the interaction flow, permissions, hosting assumptions, and page grouping.
- [ ] Resolve the editorial questions recorded in the design document.

## Phase 1 — project foundation

- [x] Create a strict TypeScript Node.js 24 LTS application using the approved modular-monolith layout.
- [x] Configure discord.js v14, Fastify, React/Vite, SQLite, Drizzle, migrations, scripts, formatting checks, and environment validation.
- [x] Add safe local configuration examples without real credentials.

## Phase 2 — rules data and publishing model

- [x] Design SQLite migrations for guild configuration, rulesets, ordered pages, drafts, published revisions, audit records, and OAuth sessions.
- [x] Import the supplied Discord and game rules as editable draft content.
- [x] Implement draft editing, ordering, preview, validation, publish, and rollback to a prior published revision.
- [x] Keep each ruleset's introduction fixed across its pages.

## Phase 3 — Discord bot and Components V2 navigation

- [x] Implement the persistent public rules launcher in a configured channel.
- [x] Implement a private Discord/Game ruleset selector.
- [x] Implement per-user ephemeral page navigation with Previous, page count, Next, and Menu controls.
- [x] Render every bot rules view using Components V2 only.
- [x] Handle stale buttons, removed pages, permissions errors, rate limits, and deleted launcher messages.

## Phase 4 — OAuth and administrator access

- [x] Implement Discord OAuth sign-in and secure server-side sessions.
- [x] Verify the configured administrator role in the configured guild on privileged API requests.
- [x] Add sign-out, session expiry, CSRF protection, and safe authorization failure handling.

## Phase 5 — web administration

- [x] Build a responsive admin interface for Discord and game rulesets.
- [x] Support editing titles, intro text, page content, page order, and enabled state.
- [x] Add preview using the same Components V2 page structure and publish status.
- [x] Add guild/channel/administrator-role configuration and a publish/update action.

## Phase 6 — operations and release readiness

- [x] Persist the target guild, channel, launcher message, and active revision in SQLite.
- [x] Make publishing update the existing launcher; if it was deleted, create a replacement and save its new message ID.
- [x] Add structured logs, health checks, database backup/restore guidance, and deployment documentation.
- [x] Perform manual validation against the acceptance criteria and document known limitations.

## Subsequent approved additions

- [x] Shared Components V2 model and visual editor for rules and bot messages.
- [x] Images after individual rules, section accessories, galleries, files, link buttons and nested block editing.
- [x] Full Information editor with containers and a built-in Read Rules button.
- [x] Bot message drafts, templates, send history and editing persistent message IDs.
- [x] Media storage, automatic migrations, backup of uploads and existing-data compatibility.
- [x] Fix stale-backend Not Found error and provide retryable composer loading failures.
- [x] Detailed admin/browser and bot-action journal with full before/after values and line diffs.
- [x] Daily JSONL, searchable web journal, full export and optional queued Discord delivery.
- [x] Keep ordinary Discord member messages outside the logging scope, as clarified by the user.
- [x] Apply the owner's AL-S visual system, source fonts, monochrome controls, background and Neural Glow.

## Modular runtime additions

- [x] Core supervisor and independent Bot/Web processes, heartbeat, watchdog and bounded restarts.
- [x] Common module lifecycle, dependencies, command registry and automatic help.
- [x] Core /ping and /status; Help /help; Info /info and administrative /send-info.
- [x] Full redacted error reports, persistent disk outbox, LOG_ID and fallback LOG_WEBHOOK.
- [x] Shared REST transport, cross-process publication locking and persistent publication nonce.
- [x] Graceful shutdown, orphan cleanup, service-manager configuration and module documentation.

## Ticket and Metrics — design prepared on 2026-10-30

Specification: [Ticket and Metrics design](docs/superpowers/specs/2026-10-30-ticket-and-metrics-design.md). The following work is planned; it is not implemented by this documentation change.

- [x] Study the Flow Bot reference and current module, OAuth and interaction architecture.
- [x] Confirm private ticket channels, both role IDs, staff discussions and full transcript scope.
- [x] Confirm close permissions, deletion after successful archiving, 180-day expiry including staff threads, and existing Prometheus/Grafana.
- [ ] Implement scoped Web permissions and a restricted Ticket-only entry path.
- [ ] Add Ticket storage, migrations and persistent operation/recovery jobs.
- [ ] Add category/panel configuration, support roles and shared Components V2 ticket actions.
- [ ] Add select-menu/modal routing and Discord ticket lifecycle handlers.
- [ ] Add bot-owned private staff threads with membership checks excluding the ticket author.
- [ ] Persist ticket/staff messages, edits, deletions and attachment copies with scoped file access.
- [ ] Build interactive transcript pages, list filters, events and role-based controls.
- [ ] Implement closing/archive/delete ordering and 180-day purge with retries.
- [ ] Add a common telemetry interface and an optional isolated Metrics exporter.
- [ ] Add cross-module instrumentation, a protected scrape endpoint and Grafana dashboard JSON.
- [ ] Update Docker configuration, backup/restore, environment examples and operator documentation.
- [ ] Run build/type/format and Compose configuration checks; report runtime validation separately. Add or run automated tests only if requested.

## Redis activity batching — approved 2026-10-30

- [x] Add a durable local activity outbox and optional Redis Streams transport.
- [x] Write up to 100 events per SQLite transaction, on a one-second timer or batch threshold.
- [x] Deduplicate event UUIDs and confirm Stream messages only after persistence.
- [x] Keep local batch processing operational during Redis outage or write rejection.
- [x] Preserve immediate rules, publication and session persistence and live Discord role checks.
- [x] Release SQLite statements between export chunks; isolate failed Discord log channels.
- [x] Add Redis AOF service, volume, safe configuration, backup and recovery documentation.
- [x] Verify unit/regression scenarios for batching, replay, fallback and log delivery.
- [ ] Run the real Redis integration test in an environment with Redis/Docker Engine available.

## Original acceptance criteria (MVP)

- The bot can publish and update one persistent launcher in the configured channel.
- The launcher opens an ephemeral ruleset selector and private paginated views for each user.
- Discord rules and game rules are separately editable, ordered, previewable, and publishable.
- The ruleset introduction stays visible while the user moves between pages.
- All rules/navigation messages use Components V2, not classic embeds.
- Only authenticated users with the configured administrator role can edit or publish.
- Rules, launcher identifiers, and published revision survive a service restart.
- Publishing a bad revision can be rolled back without losing the prior published rules.
- The app does not automatically moderate messages or issue punishments.
