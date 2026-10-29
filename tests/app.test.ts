import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { loadSeed } from '../src/server/seed.js';
import { FakeDiscord, testConfig } from './fixtures.js';

async function fixture() {
  const store = new Store(':memory:', testConfig.guildId, loadSeed());
  const discord = new FakeDiscord();
  const app = await createApp({
    config: testConfig,
    store,
    discord,
    oauth: { exchange: async () => ({ id: '666666666666666666', name: 'Admin' }) },
    logger: false,
  });
  const session = store.createSession({ id: '666666666666666666', name: 'Admin' });
  const headers = {
    cookie: 'os_session=' + session.token,
    origin: testConfig.appOrigin,
    'x-csrf-token': session.csrf,
  };
  return {
    app,
    store,
    discord,
    headers,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}
test('API denies anonymous, missing CSRF, foreign origin, and revoked role', async () => {
  const ctx = await fixture();
  try {
    assert.equal((await ctx.app.inject('/api/workspace')).statusCode, 401);
    assert.equal((await ctx.app.inject({ url: '/api/workspace', headers: ctx.headers })).statusCode, 200);
    assert.equal(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/logout',
          headers: { cookie: ctx.headers.cookie, origin: testConfig.appOrigin },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/logout',
          headers: { ...ctx.headers, origin: 'https://attacker.example' },
        })
      ).statusCode,
      403,
    );
    ctx.discord.allowed = false;
    assert.equal((await ctx.app.inject({ url: '/api/workspace', headers: ctx.headers })).statusCode, 403);
    ctx.discord.allowed = true;
    assert.equal((await ctx.app.inject({ url: '/api/workspace', headers: ctx.headers })).statusCode, 401);
  } finally {
    await ctx.close();
  }
});
test('OAuth state is cookie-bound, single-use and grants a server-side session', async () => {
  const ctx = await fixture();
  try {
    const begin = await ctx.app.inject('/auth/discord');
    const state = new URL(begin.headers.location!).searchParams.get('state')!;
    assert.equal(new URL(begin.headers.location!).searchParams.get('scope'), 'identify');
    const mismatch = await ctx.app.inject('/auth/discord/callback?code=fake&state=' + state);
    assert.equal(mismatch.statusCode, 400);
    const complete = await ctx.app.inject({
      url: '/auth/discord/callback?code=fake&state=' + state,
      headers: { cookie: 'os_oauth_state=' + state },
    });
    assert.equal(complete.statusCode, 302);
    assert.ok(complete.cookies.some((cookie) => cookie.name === 'os_session' && cookie.httpOnly));
    const replay = await ctx.app.inject({
      url: '/auth/discord/callback?code=fake&state=' + state,
      headers: { cookie: 'os_oauth_state=' + state },
    });
    assert.equal(replay.statusCode, 400);
  } finally {
    await ctx.close();
  }
});
test('draft conflict, publish failure and restore preserve the correct active snapshot', async () => {
  const ctx = await fixture();
  try {
    const channelId = '333333333333333333';
    assert.equal(
      (
        await ctx.app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers: ctx.headers,
          payload: { channelId, adminRoleId: null },
        })
      ).statusCode,
      200,
    );
    const publish = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/publish',
        headers: ctx.headers,
        payload: { version: ctx.store.getDraft().version },
      });
    assert.equal((await publish()).statusCode, 200);
    const first = ctx.store.active()!;
    const draft = structuredClone(first);
    draft.rulesets[0].pages[0].body = 'Изменённый текст';
    const update = {
      method: 'PUT' as const,
      url: '/api/draft',
      headers: ctx.headers,
      payload: { version: 1, document: draft },
    };
    assert.equal((await ctx.app.inject(update)).statusCode, 200);
    assert.equal((await ctx.app.inject(update)).statusCode, 409);
    assert.deepEqual(ctx.store.active(), first);
    ctx.discord.failPublish = true;
    assert.equal((await publish()).statusCode, 500);
    assert.deepEqual(ctx.store.active(), first);
    ctx.discord.failPublish = false;
    assert.equal((await publish()).statusCode, 200);
    assert.equal(ctx.store.active()!.rulesets[0].pages[0].body, 'Изменённый текст');
    assert.equal(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/restore/1',
          headers: ctx.headers,
          payload: { version: 2 },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(ctx.store.getDraft().document, first);
    assert.equal(ctx.store.active()!.rulesets[0].pages[0].body, 'Изменённый текст');
    assert.equal(ctx.store.getSettings().messageId, '555555555555555555');
  } finally {
    await ctx.close();
  }
});
test(
  'concurrent publication is rejected while Discord is processing the first request',
  { timeout: 5000 },
  async () => {
    const ctx = await fixture();
    try {
      ctx.store.saveSettings({ channelId: '333333333333333333', adminRoleId: null }, 'admin');
      let release!: () => void;
      ctx.discord.pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ctx.discord.onUpsert = resolve;
      });
      const first = ctx.app
        .inject({
          method: 'POST',
          url: '/api/publish',
          headers: ctx.headers,
          payload: { version: 1 },
        })
        .then((response) => response);
      await started;
      const second = await ctx.app.inject({
        method: 'POST',
        url: '/api/publish',
        headers: ctx.headers,
        payload: { version: 1 },
      });
      assert.equal(second.statusCode, 409);
      release();
      assert.equal((await first).statusCode, 200);
      assert.equal(ctx.discord.calls, 1);
    } finally {
      await ctx.close();
    }
  },
);
test('SQLite retains drafts, launcher IDs, revisions and sessions across restart', () => {
  const filename = resolve('data/test-' + randomUUID() + '.sqlite');
  const first = new Store(filename, testConfig.guildId, loadSeed());
  first.commitPublication(loadSeed(), 'admin', '333333333333333333', '555555555555555555');
  const session = first.createSession({ id: '666666666666666666', name: 'Admin' });
  first.close();
  const second = new Store(filename, testConfig.guildId, loadSeed());
  try {
    assert.equal(second.getSettings().messageId, '555555555555555555');
    assert.equal(second.getSettings().publishedRevision, 1);
    assert.equal(second.getDraft().version, 1);
    assert.equal(second.session(session.token)?.name, 'Admin');
    assert.deepEqual(second.active(), loadSeed());
  } finally {
    second.close();
    for (const file of [filename, filename + '-wal', filename + '-shm'])
      if (existsSync(file)) unlinkSync(file);
  }
});
