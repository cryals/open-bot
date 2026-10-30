// Standalone fake Discord server for browser QA; never loaded by the production entrypoint.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { loadSeed } from '../src/server/seed.js';
import { FakeDiscord, testConfig } from './fixtures.js';

const store = new Store(':memory:', testConfig.guildId, loadSeed());
const port = Number(process.env.UI_PORT || 3311);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid UI_PORT');
const origin = `http://localhost:${port}`;
const app = await createApp({
  config: {
    ...testConfig,
    port,
    origin,
    appOrigin: origin,
    redirect: new URL(origin + '/auth/discord/callback'),
  },
  store,
  discord: new FakeDiscord(),
  oauth: { exchange: async () => ({ id: '666666666666666666', name: 'Администратор' }) },
  logger: false,
});
const session = store.createSession({ id: '666666666666666666', name: 'Администратор' });
mkdirSync('output/playwright', { recursive: true });
writeFileSync(
  'output/playwright/auth.json',
  JSON.stringify({
    cookies: [
      {
        name: 'os_session',
        value: session.token,
        domain: 'localhost',
        path: '/',
        expires: session.expiresAt / 1000,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  }),
);
process.once('SIGINT', () => void app.close());
process.once('SIGTERM', () => void app.close());
await app.listen({ port, host: '127.0.0.1' });
console.log(`Local QA harness: ${origin} (fake Discord, in-memory database)`);
