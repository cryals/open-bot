<p align="center">
  <img src="docs/assets/open-bot-cover.png" alt="Open Bot — Discord server management" width="1000">
</p>

<p align="center">
  <sub><code>LANGUAGE</code></sub><br>
  <b>English</b> · <a href="README_RU.md">Русский</a>
</p>

<p align="center">
  <b>Your Discord server. One control panel.</b><br>
  Write the rules. Build the message. Keep a record of every change.
</p>

<p align="center">
  <img src="docs/assets/badges/status.svg" alt="Status: release">
  <a href="https://nodejs.org/en/download"><img src="docs/assets/badges/runtime.svg" alt="Node.js 24.18 or newer"></a>
  <a href="docs/MODULES.md"><img src="docs/assets/badges/discord.svg" alt="Discord Components V2"></a>
  <a href="docs/OPERATIONS.md"><img src="docs/assets/badges/hosting.svg" alt="Self-hosted"></a>
  <a href="https://github.com/cryals/open-bot/actions/workflows/check.yml"><img src="docs/assets/badges/checks.svg" alt="CI: view actual workflow runs"></a>
  <a href="LICENSE"><img src="docs/assets/badges/license.svg" alt="Custom project license"></a>
</p>

<p align="center">
  <a href="#docker">Docker</a> · <a href="#quick-start">Node.js</a> · <a href="docs/OPERATIONS.md">Deployment</a> · <a href="docs/MODULES.md">Modules</a> · <a href="LICENSE">License</a>
</p>

---

**Open Bot** is a self-hosted Discord management bot with a web panel, a visual message editor, and modular slash commands. Publish community information, maintain Discord and game rules, and let each member browse their own copy of the rules without changing anyone else's page.

**Release 1.0.** [User portal](docs/user/README.md) · [Developer portal](docs/developer/README.md). After installation, both portals are available at **`/docs/`** on the panel's address, with UI screenshots and task-based guides.

Open Bot is the product name. **Open Space** is the community used in the supplied rule content. Each installation currently manages **one Discord guild**.

## Features

- **Rules that members can browse.** One public entry message, private navigation, logical pages, and an introduction that stays visible on every page.
- **A visual Components V2 editor.** Text, containers, sections, images, galleries, files, dividers, and link buttons. Reorder, duplicate, or move blocks between containers.
- **Messages sent as the bot.** Drafts, templates, up to ten messages per dispatch, notification settings, and edits to previously sent messages using saved IDs.
- **Drafts and publication history.** Save without publishing, review the preview, publish deliberately, or restore an older version to the draft.
- **An administration panel.** Discord OAuth sign-in, current guild-role checks, and configurable administrator access.
- **Detailed activity records.** UI actions, field edits, before/after values, line diffs, and bot operations in SQLite and JSONL.
- **A modular runtime.** Core, Web, Help, and Info; separate Bot and Web processes; supervised recovery; persistent error delivery with a webhook fallback.

## How it works

1. Open the panel and sign in with Discord.
2. Choose the destination channel and administrator role.
3. Build the information message and edit the rule pages.
4. Save the draft, then publish it when ready.
5. Members press **Read rules** and browse Discord or game rules privately.

The information editor can also hold wiki, launcher, support, and document links. A subsequent publication updates the stored message instead of posting another copy. If the message was deleted, the next publication creates a replacement and stores its ID.

## Docker

Requires Docker Engine with Compose or Docker Desktop using Linux containers. From a clone of this repository:

```sh
cp .env.example .env
```

Fill in the Discord credentials and OAuth callback in `.env`, then start:

```sh
docker compose up -d --build
```

The default panel address is [localhost:3000](http://localhost:3000). SQLite, uploads, logs and backups persist in a named volume. Node.js is installed inside the image. On PowerShell, use `Copy-Item` instead of `cp`.

For a public domain with automatic HTTPS, configure `DOMAIN` and `REDIRECT`, then run:

```sh
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

See the [Docker guide (Russian)](docs/DOCKER.md) for Discord setup, an existing parent `.env`, backups, migration, ports, and HTTPS.

## Quick start

Requires **Node.js 24.18+** and a Discord application with a bot account.

```sh
git clone https://github.com/cryals/open-bot.git
cd open-bot
npm ci
cp .env.example .env
```

On PowerShell, use `Copy-Item .env.example .env` for the last command. Access to the repository is required if it is private.

Fill in `.env`:

```dotenv
BOT_TOKEN=your_bot_token
GUILD_ID=your_discord_server_id
CLIENT_ID=your_application_id
CLIENT_SECRET=your_oauth_client_secret
PORT=3000
REDIRECT=http://localhost:3000/auth/discord/callback
```

In the [Discord Developer Portal](https://discord.com/developers/applications), add the exact `REDIRECT` URL under **OAuth2 → Redirects**. Install the application into the guild with the `bot` and `applications.commands` scopes. Give the bot **View Channel**, **Send Messages**, **Read Message History**, and **Attach Files** in the channels it will use. Only the **Guilds** Gateway intent is used.

```sh
npm run build
npm start
```

Open [localhost:3000](http://localhost:3000), sign in, select a channel in **Settings**, and publish your first information message. The configured `PORT` determines the actual address.

See the [operations guide (Russian)](docs/OPERATIONS.md) for environment variables, access rules, HTTPS, backups, and recovery.

## Commands

| Command                | Module | Purpose                                                                 |
| ---------------------- | ------ | ----------------------------------------------------------------------- |
| `/help [module]`       | Help   | Browse commands grouped by module.                                      |
| `/ping`                | Core   | Pong, interaction acknowledgement time, Gateway latency, and uptime.    |
| `/info`                | Info   | Open the published Discord / game rules menu.                           |
| `/status`              | Core   | Administrator diagnostics for processes and modules.                    |
| `/send-info [channel]` | Info   | Administrator publication of the latest published information snapshot. |

Commands register automatically in the configured guild. `/send-info` uses the **published snapshot**; it does not publish unfinished web-panel drafts.

## Modular by design

<p align="center">
  <img src="docs/assets/open-bot-modules.png" alt="Concept illustration of a modular control system" width="1000">
</p>

Core starts the services. Help reads command definitions from the module registry. Info handles published information and rule navigation. Web provides the panel and OAuth flow in a separate process.

The supervisor monitors both workers and restarts a failed worker with backoff. Optional module failures are isolated during initialization. An external service manager restarts the supervisor itself in production. See [modules and recovery](docs/MODULES.md) for the lifecycle and how to add a module.

## Activity and errors

**Activity** records administrator and bot actions, including text changes and line diffs. Browse and export the full record in the panel. Choose an activity channel in **Settings** to deliver new events to Discord. Ordinary members' messages are not monitored.

**Error reports** use separate configuration:

```dotenv
LOG_ID=error_channel_id
LOG_WEBHOOK=https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
```

Reports are written to disk first. Delivery uses the bot channel when available, then an independent webhook if needed. If both fail, the persistent queue retries later. Reports include an error ID, process, scope, stack, and a JSON attachment. The activity channel and `LOG_ID` serve different purposes.

## Deployment and data

Use [Docker Compose](docs/DOCKER.md) or run the built application with `npm start`. For a native installation, a [systemd service example](docs/open-bot.service) is included. Docker has an optional Caddy configuration for HTTPS; a native installation needs its own reverse proxy.

```sh
npm run backup
```

Backups contain the SQLite database, uploads, and activity/error logs. Restore them together while the service is stopped. A [step-by-step guide](docs/OPERATIONS.md#резервные-копии-и-восстановление) covers deployment and recovery.

```text
src/server/     Discord, OAuth, API, publishing, runtime and modules
src/shared/     Shared schemas, block model and pagination
src/web/        Administration panel and visual editor
rules/          Initial Discord and game rule content
migrations/     Versioned SQLite migrations
docs/           Operations, module guide and README artwork
data/           Local database, uploads, logs and backups; ignored by Git
```

## Development

```sh
npm run dev
npm run typecheck
npm run format:check
npm run build
```

For the Vite interface, set `APP_ORIGIN=http://localhost:5173` in `.env`; keep the OAuth callback on the backend port. Existing automated checks run with `npm test`. The [Checks workflow](https://github.com/cryals/open-bot/actions/workflows/check.yml) runs formatting, build, and tests on pushes and pull requests. The CI badge above links to its actual runs.

**Stack:** Node.js 24 · TypeScript · discord.js 14 · Fastify 5 · React 19 · Vite · SQLite · Drizzle ORM.

## Activity buffering

Activity events use Redis Streams and SQLite batches of up to 100 events, flushed every second. A durable local outbox supports replay after worker or Redis failures; UUIDs deduplicate SQLite writes. If Redis is unavailable, the same batch writer processes the disk queue directly. Rules, sessions, publication revisions and message IDs still commit immediately to SQLite. Compose includes a private Redis service with AOF; standalone deployments can set `REDIS_URL`. See [operations](docs/OPERATIONS.md#пакетный-журнал-и-redis) for recovery and backup constraints.

## License

[Open Bot Project License 1.0](LICENSE) — a custom source-available license. Private non-commercial use is permitted. Public or community deployment, redistribution, and commercial use require prior written permission from cryals. The full terms are in `LICENSE`, in English and Russian; licensing contact: `support@stopco.ru`.

Third-party components retain their own licenses; see [notices](THIRD_PARTY_NOTICES.md).

<p align="center">
  <sub>Open Bot · by <a href="https://github.com/cryals">cryals</a> · <a href="docs/ARTWORK.md">Artwork and badge sources</a></sub>
</p>
