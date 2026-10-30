---
name: open-bot-modules
description: 'Create or maintain Open Bot modules, slash commands, interaction handlers and their web settings. Use for the cryals/open-bot repository; preserve its Bot/Web process boundaries and shared publishing model.'
---

# Open Bot modules

Find the Open Bot checkout first (`package.json` name `open-bot`, remote `cryals/open-bot`). Read its `AGENTS.md`; do not assume the owner's Windows path exists on another machine.

## Start from the actual contract

Read `src/server/runtime/types.ts`, `module-manager.ts`, `modules/catalog.ts` and the nearest existing module. Use `docs/developer/modules.md` for the maintained guide. Specs alone do not establish that a module is implemented.

- Register a default-exported `BotModule` in the catalog. Help and slash registration derive from this definition; do not create a second command registry.
- Only Bot owns Gateway. Web uses REST in a separate process; in-memory services are not shared. Introduce explicit persistence/IPC if a web change must trigger Bot work.
- Commands are already deferred privately by ModuleManager: use `editReply`. Button handlers acknowledge themselves. Use Components V2 and compact versioned custom IDs; scope private views to the interacting user.
- Administrative commands require `admin: true` and Discord default permissions. API routes retain live server-side role checks and Origin/CSRF protection. Never cache authorization in Redis.

## Lifecycle and side effects

Honor the supplied AbortSignal in external I/O. `stop` must clear subscriptions/timers even after partial initialization; failed optional starts can be retried by the manager. Avoid a second retry loop around the same operation.

Reuse Publisher for rules/info publication and its SQLite lock, version checks and persisted attempts. Keep critical settings, publication results and message IDs synchronous in SQLite; only activity events are deferred. Add a new numbered migration rather than changing applied history.

For state-changing integrations, define what survives a crash and how an unknown remote result is reconciled. A timeout does not prove that a remote action failed. Do not automatically retry game-server power actions or real content publication as a diagnostic step.

## Completion

Use `docs/developer/telemetry.md` when adding logging or metrics. Record safe actor/operation/result projections, never credentials. Update user commands, developer docs and env/backup guidance if their contracts changed.

Follow the user's requested validation scope. FakeDiscord and local builds cover development without posting to the real guild. State which checks ran and which did not. Docker availability follows the current machine instructions; it is not a module prerequisite.
