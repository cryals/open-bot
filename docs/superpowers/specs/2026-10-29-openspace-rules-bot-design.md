# Open Space Rules Bot — design proposal

**Status:** Implementation approved by the user on 2026-10-29; MVP implemented. See README.md for current configuration and operation.

**Implementation details:** SQLite stores each editable rules document and immutable published snapshot as schema-validated JSON, with separate settings, audit, OAuth-state, and session tables. Page order is the order in the document. This keeps a save or publication atomic. OAuth only requests identify: current roles are checked through the bot's single-member REST endpoint on every protected request. Until a specific role is configured, guild Administrator permission grants access; the guild owner retains recovery access.

## Goal

Publish the Open Space Discord community rules and in-game rules through one persistent Discord message. Members select a ruleset and browse logical pages. Administrators edit both rulesets in a web panel and publish reviewed changes.

## Product decisions and assumptions

- MVP supports one configured Discord guild. The data model should retain guild IDs so multi-guild support can be added later without redesigning every record.
- The public launcher lives in a channel selected in the web panel.
- A member clicks the launcher and receives an ephemeral selector and ephemeral rules pages. Other members do not see or control that member's current page.
- The first page of each ruleset has a short persistent introduction, repeated above the page body as the member navigates. The game rules introduction follows the existing Open Space introduction. The Discord rules introduction explains that the rules supplement Discord Terms and Community Guidelines and that violations can lead to moderation action.
- Discord rules are grouped into pages by logical sections. Game rules use the existing top-level sections as page groups; long sections can be split into sequential pages if the Discord component limits require it.
- The web panel uses Discord OAuth and a configured administrator role as the access gate. OAuth authenticates the account; the server checks the role against the configured guild before allowing edits or publishing.
- The bot is a rules delivery tool only; it does not monitor conversation or automate moderation.

## Interaction flow

1. An administrator signs into the web panel with Discord and configures the guild, destination channel, and administrator role.
2. The administrator edits or reorders draft pages, reviews the preview, then publishes.
3. The bot creates or edits a persistent Components V2 launcher in the chosen channel and stores its message ID and active published revision.
4. A member clicks “Читать правила”. The bot replies ephemerally with “Discord” and “Игра” choices.
5. The member selects a ruleset. The bot shows the persistent intro, current page title and body, and Previous / page count / Next / Menu controls.
6. Navigation updates only that member's ephemeral response. At the first or last page, the unavailable direction is disabled or omitted. Menu returns to the ruleset selector.

The interaction layout follows the supplied screenshots: a public information/launcher message, followed by private navigation. For game rules, the fixed Open Space intro remains visible on every page.

## Components V2 requirement

Every bot-rendered launcher, selector, rules page, and navigation control uses Discord Components V2. Do not render the rules as classic embeds. Build messages from Components V2 containers/text/separators and action rows/buttons supported by the installed discord.js version. Validate component count and text lengths before publish so an invalid page cannot break navigation at runtime.

## Proposed stack

### Recommended: modular monolith

- Node.js 24 LTS with strict TypeScript.
- discord.js v14 for the gateway bot, interactions, and Components V2 builders.
- Fastify for the web API, OAuth callback, and admin routes.
- React + Vite for the admin SPA.
- SQLite through better-sqlite3 and Drizzle ORM/migrations.
- One deployable Node service and one SQLite database for the single-guild MVP. The built frontend can be served by Fastify or by a reverse proxy.

This keeps the bot, publishing workflow, and admin API close to one source of truth, with a low operational burden for one community.

### Alternatives considered

1. Separate bot and admin/API services with shared database: allows independent scaling and deployments, but adds service coordination and operations that are not needed for a one-guild MVP.
2. Bot plus JSON files without a web service/database: quickest for a static rules menu, but weak for concurrent edits, role-gated administration, revisions, and reliable publishing history.

## Data model proposal

- **GuildConfig:** guild ID, rules channel ID, launcher message ID, admin role ID, enabled state, timestamps.
- **Ruleset:** stable key (`discord` or `game`), title, fixed introduction, display order, enabled state.
- **RulePage:** ruleset ID, stable page ID, title, Markdown body, display order, enabled state.
- **RulesRevision:** immutable published snapshot, revision number, publisher user ID, publication time, source draft metadata.
- **AdminAudit:** actor, action, target, timestamp, and compact change summary for edits and publication.
- **WebSession:** server-side OAuth session data with expiry; store only what is required and protect cookies.

Draft state remains editable. Publishing creates an immutable snapshot and switches the active revision only after Discord accepts the updated launcher. The previous revision remains available for rollback. Rule page navigation reads from the active snapshot.

## Admin panel

- Discord OAuth login and logout.
- Access only for members with the configured administrator role in the configured guild.
- Separate Discord and game rules editors.
- Edit the ruleset title and fixed introduction; edit page title and Markdown body; reorder, add, remove, enable, and disable pages.
- Preview one page and the full navigation flow before publishing.
- Configure the target channel and administrator role.
- Publish/update launcher and show the currently active revision, last publisher, and publication time.
- No public editing endpoint and no secrets in browser storage.

## Source content and review notes

- Keep the existing root rule.md as the source copy; copy it into rules/game.md for later import after review.
- Seed the Discord rules from the text supplied in the request and store them in rules/discord.md.
- The supplied Discord rules have a duplicated number 9 and one entry has no space after its number. The page grouping can preserve the text while the final displayed numbering is normalized only after user review.
- The current root rule.md includes an age-based restriction on romantic relationships in section 1, while the conversation clarified that ERP is forbidden outright at every age and RRP is limited to flirtation, hugs, kisses, and weddings. This planning task will preserve the source file and flag this discrepancy instead of silently changing it. Review the canonical game rule text before importing it.
- The existing rules file has separate ERP and RRP sections. Preserve their distinction: ERP is prohibited, and RRP is limited to the explicitly allowed non-erotic gestures. No sexual act, nudity for ERP, or explicit content is allowed.

## Security and reliability

- Store the Discord bot token, OAuth client secret, session secret, and database path in server-side environment/configuration. Never ship credentials to the SPA.
- Use HTTPS in deployment, HttpOnly/Secure/SameSite cookies, bounded session lifetime, CSRF protection for mutations, and strict redirect URI validation.
- Check the configured admin role on the server for each privileged request; do not trust a role claim supplied by the browser.
- Restrict bot permissions to the configured rules channel where practical: view channel, send messages, read message history, and use application commands/interactions as required.
- Use migrations, routine SQLite backups, input validation, and structured logs. Do not log OAuth tokens or session secrets.
- Publishing should be transactional from the app's perspective: retain the old active revision if Discord rejects the new payload. If the launcher message is missing, create a replacement and persist its new ID.

## Open review points

1. Confirm this interaction model: public launcher, ephemeral ruleset selection and private page navigation.
2. Confirm single-guild MVP and whether the target channel/admin role are configured in the web panel.
3. Review the source-rule discrepancy noted above and approve the canonical game rules before data import.
4. Confirm whether the Discord-rules numbering should be normalized to unique sequential numbers in the published pages.

## Acceptance criteria

- A member can access both rule sets from one stable launcher and navigate each independently.
- Page controls affect only the user who clicked them.
- The game introduction remains visible on all game pages.
- Rule content can be edited and reordered in the authenticated admin panel and published as a new revision.
- A user without the configured role cannot edit or publish.
- Launcher channel/message IDs and active revision are persisted and recoverable after restart or message deletion.
- All rules UI is Components V2; no classic embeds are used.
