// Standalone fake Discord server for browser QA; never loaded by the production entrypoint.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { loadSeed } from '../src/server/seed.js';
import { FakeDiscord, testConfig } from './fixtures.js';

const store = new Store(':memory:', testConfig.guildId, loadSeed());
const app = await createApp({
  config: testConfig,
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
await app.listen({ port: 3311, host: '127.0.0.1' });
console.log('Local QA harness: http://localhost:3311 (fake Discord, in-memory database)');
