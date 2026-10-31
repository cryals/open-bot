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

Ticket handles buttons/selects/modals through `interactions` and `permission: 'ticketManage'`; Help must use the same permission contract. Gateway collection is opt-in through application settings/Message Content. Full histories only cover ticket channels/threads; AutoMod evidence expires and explicit guild backups include configured message snapshots. Preserve the separate full/view roles and author exclusion from staff scope.

Use module_config optimistic versions for shared settings. Ticket lifecycle/access changes and server watches are persisted Bot jobs, not Web timers. Watchdog confirmations pin actor/config and never auto-retry POST; unknown results block even old pending confirmations until manual resolution. Tokens are ENV references and endpoint hosts come from deployment allowlists. See docs/developer/integrations.md.

Honor the supplied AbortSignal in external I/O. `stop` must clear subscriptions/timers even after partial initialization; failed optional starts can be retried by the manager. Avoid a second retry loop around the same operation.

Reuse Publisher for rules/info publication and its SQLite lock, version checks and persisted attempts. Keep critical settings, publication results and message IDs synchronous in SQLite; only activity events are deferred. Add a new numbered migration rather than changing applied history.

For state-changing integrations, define what survives a crash and how an unknown remote result is reconciled. A timeout does not prove that a remote action failed. Do not automatically retry game-server power actions or real content publication as a diagnostic step.

Game Server Status uses one typed configuration for SS14, SS13, Minecraft Java/Bedrock, Terraria TShock and Project Zomboid. Preserve default SS14 decoding and keep Watchdog identity independent. Protocols live in game-server-status/protocols.ts; normalized persisted samples/metrics projections live in state.ts. TShock only stores GAME_SERVER_TOKEN_* references, never credentials in URLs or records.

## Completion

Use `docs/developer/telemetry.md` when adding logging or metrics. Record safe actor/operation/result projections, never credentials. Update user commands, developer docs and env/backup guidance if their contracts changed.

Follow the user's requested validation scope. FakeDiscord and local builds cover development without posting to the real guild. State which checks ran and which did not. Docker availability follows the current machine instructions; it is not a module prerequisite.

## Community modules

Use communityDefinitions, CommunityStore, JobStore and the catalog. Operational settings belong to SQLite/web. ENV retains secrets and deployment parameters. Intent changes require explicit restart and applied-state reporting.

Use GuildAuthority for guild ownership, hierarchy and safe roles. Public issuance excludes application-access roles and dangerous Discord permissions. Form reviewer access is per current form, distinct from formsView. Applicant OAuth never opens staff routes. Authorization bypasses the message-policy config cache.

Keep unknown sanctions/restore steps stopped for reconciliation. New channels start closed. Replacement requires a confirmed plan and fresh source ownership/fingerprint checks. Never repeat an uncertain remote mutation automatically.
