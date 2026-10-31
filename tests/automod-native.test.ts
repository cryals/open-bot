import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDiscord, testConfig } from './fixtures.js';
import { Store } from '../src/server/store.js';
import { loadSeed } from '../src/server/seed.js';
import { ActivityService } from '../src/server/activity.js';
import { CommunityStore } from '../src/server/community-store.js';
import { TtlCounters } from '../src/server/ttl-counters.js';
import { MessagePolicyService, type ObservedMessage } from '../src/server/modules/automod/service.js';
import { nativeTrigger } from '../src/server/modules/automod/native.js';
import { automodSchema } from '../src/shared/community.js';
import type { ModuleContext } from '../src/server/runtime/types.js';
import { ErrorReporter } from '../src/server/runtime/error-reporter.js';
import type { RestPort } from '../src/server/module-http.js';
import { EventEmitter } from 'node:events';
import { CommunityRuntime } from '../src/server/community-runtime.js';
import type { BotContext } from '../src/server/runtime/types.js';

const rule = (overrides = {}) =>
  automodSchema.parse({
    rules: [
      {
        id: 'bad-word',
        name: 'Blocked words',
        filter: 'words',
        values: ['spam'],
        native: true,
        observe: false,
        action: 'delete',
        ...overrides,
      },
    ],
  }).rules[0];
class NativeDiscord extends FakeDiscord {
  rules = new Map<string, Record<string, unknown>>();
  deletes: string[] = [];
  posts = 0;
  patches = 0;
  losePost = false;
  failSync = false;
  rest = Object.fromEntries(
    ['get', 'post', 'patch', 'delete', 'put'].map((method) => [
      method,
      async (path: string, options?: { body?: Record<string, unknown> }) => {
        if (path.includes('/auto-moderation/rules')) {
          if (this.failSync) throw new Error('Native API unavailable');
          const id = path.split('/').at(-1)!;
          if (method === 'get') return [...this.rules.values()];
          if (method === 'delete') {
            this.rules.delete(id);
            return {};
          }
          if (method === 'post') {
            this.posts++;
            const created = {
              ...options?.body,
              id: String(800000000000000000n + BigInt(this.posts)),
              creator_id: testConfig.clientId,
            };
            this.rules.set(created.id, created);
            if (this.losePost) {
              this.losePost = false;
              throw new Error('Lost POST response');
            }
            return created;
          }
          this.patches++;
          const existing = this.rules.get(id);
          assert.ok(existing);
          Object.assign(existing, options?.body);
          return existing;
        }
        if (path.endsWith('/roles'))
          return [
            { id: testConfig.guildId, position: 0, permissions: '0' },
            { id: '444444444444444444', position: 10, permissions: '8' },
          ];
        if (path.includes('/members/'))
          return { user: { id: testConfig.clientId }, roles: ['444444444444444444'] };
        if (path === `/guilds/${testConfig.guildId}`)
          return { id: testConfig.guildId, owner_id: '666666666666666666' };
        if (method === 'delete' && path.includes('/messages/')) {
          this.deletes.push(path);
          return {};
        }
        throw new Error(`Unexpected REST ${method} ${path}`);
      },
    ]),
  ) as unknown as RestPort;
}
function setup() {
  const store = new Store(':memory:', testConfig.guildId, loadSeed()),
    discord = new NativeDiscord(),
    configs = new CommunityStore(store),
    activity = new ActivityService(store, discord, [], { deliver: false }),
    counters = new TtlCounters(testConfig, () => {}),
    context: ModuleContext = {
      config: testConfig,
      store,
      discord,
      activity,
      errors: new ErrorReporter(testConfig, 'test'),
    };
  configs.save('automod', { enabled: true, rules: [rule()] }, 0);
  return { store, discord, configs, context, policy: new MessagePolicyService(context, counters) };
}
const message = (id: string, content = 'spam'): ObservedMessage => ({
  id,
  content,
  guild_id: testConfig.guildId,
  channel_id: '333333333333333333',
  author: { id: '666666666666666666', username: 'Example' },
  member: { roles: [] },
  attachments: [],
});

test('Native filters use bot enforcement before successful synchronization and deduplicate Gateway events', async () => {
  const { store, discord, policy } = setup();
  try {
    await policy.process(message('700000000000000001'));
    await policy.process(message('700000000000000001'));
    assert.equal(discord.deletes.length, 1);
    assert.equal(
      (store.sqlite.prepare('SELECT COUNT(*) n FROM automod_evidence').get() as { n: number }).n,
      1,
    );
    await policy.process({
      ...message('700000000000000002'),
      author: { id: testConfig.clientId, username: 'Bot', bot: true },
    });
    assert.equal(discord.deletes.length, 1);
  } finally {
    store.close();
  }
});

test('Native delegation requires the exact synchronized rule and enabled state', async () => {
  const { store, discord, configs, policy } = setup();
  try {
    await policy.syncNative();
    await policy.process(message('700000000000000001'));
    assert.equal(discord.deletes.length, 0);
    configs.save('automod', { enabled: true, rules: [rule({ values: ['changed'] })] }, 1);
    await policy.process(message('700000000000000002', 'changed'));
    assert.equal(discord.deletes.length, 1);
    await policy.syncNative();
    await policy.process(message('700000000000000003', 'changed'));
    assert.equal(discord.deletes.length, 1);
    configs.save('automod', { enabled: false, rules: [rule({ values: ['changed'] })] }, 2);
    await policy.syncNative();
    configs.save('automod', { enabled: true, rules: [rule({ values: ['changed'] })] }, 3);
    await policy.process(message('700000000000000004', 'changed'));
    assert.equal(discord.deletes.length, 2);
    discord.failSync = true;
    await assert.rejects(policy.syncNative(), /unavailable/);
    await policy.process(message('700000000000000005', 'changed'));
    assert.equal(discord.deletes.length, 3);
  } finally {
    store.close();
  }
});

test('Native lost POST is reconciled without a duplicate; deleted remote rules can be recreated', async () => {
  const { store, discord, policy } = setup();
  try {
    discord.losePost = true;
    await assert.rejects(policy.syncNative(), /Lost POST/);
    assert.equal(discord.rules.size, 1);
    await policy.syncNative();
    assert.equal(discord.posts, 1);
    assert.equal(discord.patches, 1);
    await policy.process(message('700000000000000001'));
    assert.equal(discord.deletes.length, 0);
    discord.rules.clear();
    await policy.syncNative();
    assert.equal(discord.posts, 2);
    assert.equal(discord.rules.size, 1);
  } finally {
    store.close();
  }
});

test('Native trigger changes replace the rule; another application rule is never modified', async () => {
  const { store, discord, configs, policy } = setup();
  try {
    await policy.syncNative();
    configs.save('automod', { enabled: true, rules: [rule({ filter: 'mentions' })] }, 1);
    await policy.syncNative();
    assert.equal(discord.rules.size, 1);
    assert.equal(discord.posts, 2);
    const remote = [...discord.rules.values()][0];
    remote.creator_id = '999999999999999999';
    await assert.rejects(policy.syncNative(), /другому приложению/);
    assert.equal(discord.patches, 0);
    assert.equal(discord.rules.size, 1);
  } finally {
    store.close();
  }
});

test('Native conversion preserves substring keywords and rejects unsupported semantics before API mutation', () => {
  assert.deepEqual(nativeTrigger(rule()), { keyword_filter: ['*spam*'] });
  assert.deepEqual(nativeTrigger(rule({ wholeWords: true })), { keyword_filter: ['spam'] });
  assert.throws(() => nativeTrigger(rule({ filter: 'rate' })), /поддерживает/);
  assert.throws(() => nativeTrigger(rule({ action: 'notify' })), /notify/);
  assert.throws(() => nativeTrigger(rule({ values: ['x'.repeat(59)] })), /60/);
  assert.throws(() => nativeTrigger(rule({ values: ['*'] })), /без/);
  assert.throws(() => nativeTrigger(rule({ filter: 'mentions', threshold: 51 })), /50/);
});

test('Join events reach the durable queue even when the in-memory Gateway queue is full', async () => {
  const { store, configs, context, discord } = setup(),
    client = new EventEmitter(),
    scopes: string[] = [];
  configs.save('autoban', { enabled: true }, 0);
  context.errors.report = (_error, scope) => {
    scopes.push(scope);
    return 'test-error';
  };
  // No worker manager is needed: this fixture only starts Gateway ingestion, never the scheduled tick.
  const runtime = new CommunityRuntime({
    ...context,
    discord: Object.assign(discord, { client }),
  } as unknown as BotContext);
  try {
    await runtime.start();
    for (let i = 0; i < 300; i++)
      client.emit('raw', { t: 'GUILD_UPDATE', d: { guild_id: testConfig.guildId } });
    const join = {
      t: 'GUILD_MEMBER_ADD',
      d: {
        guild_id: testConfig.guildId,
        user: { id: '666666666666666666', username: 'Example' },
        roles: [],
        joined_at: '2026-10-31T00:00:00.000Z',
      },
    };
    client.emit('raw', join);
    client.emit('raw', join);
    assert.deepEqual(scopes, ['community.overload']);
    assert.equal(
      (
        store.sqlite.prepare("SELECT COUNT(*) n FROM core_jobs WHERE kind='community.join'").get() as {
          n: number;
        }
      ).n,
      1,
    );
  } finally {
    await runtime.stop();
    store.close();
  }
});
