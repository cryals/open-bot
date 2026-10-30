import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityQueue, type ActivityEvent, type ActivityStream } from '../src/server/activity-queue.js';
import { ActivityService } from '../src/server/activity.js';
import { Store } from '../src/server/store.js';
import { loadSeed } from '../src/server/seed.js';
import { FakeDiscord, testConfig } from './fixtures.js';
import type { DiscordPort } from '../src/server/discord.js';

const actor = { userId: '666666666666666666', name: 'Admin' };
const event = (): ActivityEvent => ({
  eventId: crypto.randomUUID(),
  createdAt: Date.now(),
  actor: actor.userId,
  actorName: actor.name,
  kind: 'ui.click',
  target: 'button',
  summary: 'Click',
  details: {},
  before: null,
  after: null,
  diff: null,
});
class FakeStream implements ActivityStream {
  available = true;
  rejectAppend = false;
  rejectAck = false;
  entries: { id: string; message: Record<string, string> }[] = [];
  ready() {
    return this.available;
  }
  async append(events: ActivityEvent[]) {
    if (this.rejectAppend) throw new Error('Redis OOM');
    this.entries.push(
      ...events.map((event) => ({ id: crypto.randomUUID(), message: { event: JSON.stringify(event) } })),
    );
  }
  async read() {
    return this.entries.slice(0, 100);
  }
  async acknowledge(ids: string[]) {
    if (this.rejectAck) throw new Error('Connection lost before ACK');
    this.entries = this.entries.filter((entry) => !ids.includes(entry.id));
  }
  close() {}
}
test('activity batches preserve events on disk, retry failed persistence, and ACK only after commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-bot-activity-'));
  const stream = new FakeStream();
  const calls: number[] = [];
  const received = new Set<string>();
  let fail = true;
  const queue = new ActivityQueue(
    root,
    (events) => {
      if (fail) throw new Error('SQLite unavailable');
      calls.push(events.length);
      for (const event of events) received.add(event.eventId);
    },
    { consume: true, stream },
  );
  try {
    for (let i = 0; i < 20; i++) queue.enqueue(event());
    assert.equal(calls.length, 0);
    assert.equal(readdirSync(root).length, 20);
    await queue.flush();
    assert.equal(stream.entries.length, 20);
    assert.equal(readdirSync(root).length, 20);
    fail = false;
    stream.rejectAck = true;
    await queue.flush();
    assert.equal(received.size, 20);
    assert.equal(stream.entries.length, 20);
    stream.rejectAck = false;
    await queue.flush();
    assert.equal(stream.entries.length, 0);
    assert.equal(received.size, 20);
    assert.equal(readdirSync(root).length, 0);
    assert.deepEqual(calls, [20, 20]);
  } finally {
    await queue.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('local outbox survives consumer restart and Redis offline / OOM use batch fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-bot-restart-'));
  const stream = new FakeStream();
  const collected: ActivityEvent[] = [];
  const producer = new ActivityQueue(root, () => assert.fail('Web must not write SQLite'), {
    consume: false,
  });
  for (let i = 0; i < 12; i++) producer.enqueue(event());
  await producer.close();
  const consumer = new ActivityQueue(root, (events) => collected.push(...events), { consume: true, stream });
  try {
    stream.available = false;
    await consumer.flush();
    assert.equal(collected.length, 12);
    assert.match(consumer.error!, /Redis/);
    consumer.enqueue(event());
    stream.available = true;
    stream.rejectAppend = true;
    await consumer.flush();
    assert.equal(collected.length, 13);
    assert.equal(readdirSync(root).length, 0);
    stream.rejectAppend = false;
    await consumer.flush();
    assert.equal(consumer.error, null);
  } finally {
    await consumer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite deduplicates event UUIDs and export never holds a busy statement across yields', async () => {
  const store = new Store(':memory:', testConfig.guildId, loadSeed());
  const activity = new ActivityService(store, new FakeDiscord(), [], { deliver: false });
  try {
    const id = activity.record(actor, { kind: 'rules.save', target: 'rules', summary: 'Saved' });
    assert.equal(activity.list().entries.length, 0);
    await activity.ingest();
    const original = activity.list().entries[0];
    assert.equal(original.eventId, id);
    // Exercise the same event replay after a stream ACK was lost.
    const replay: ActivityEvent = { ...original, eventId: id };
    const replayQueue = new ActivityQueue(
      mkdtempSync(join(tmpdir(), 'open-bot-replay-')),
      (events) => {
        // Replay through the actual ingestion writer, not a mock SQL implementation.
        (activity as unknown as { persist(events: ActivityEvent[]): void }).persist(events);
      },
      { consume: true },
    );
    try {
      replayQueue.enqueue(replay);
      await replayQueue.flush();
    } finally {
      await replayQueue.close();
      rmSync(replayQueue.root, { recursive: true, force: true });
    }
    assert.equal(activity.list().entries.length, 1);
    const iterator = activity.export();
    assert.ok(iterator.next().value);
    assert.equal(store.saveDraft(loadSeed(), 1, actor.userId).version, 2);
    iterator.return();
  } finally {
    await activity.close();
    store.close();
  }
});

test('a broken Discord log channel does not starve subsequent healthy channels', async () => {
  const store = new Store(':memory:', testConfig.guildId, loadSeed());
  const discord: DiscordPort = new FakeDiscord();
  const channels: string[] = [];
  discord.sendMessage = async (_message, channel) => {
    channels.push(channel);
    if (channel === '333333333333333333') throw new Error('Deleted channel');
    return '777777777777777777';
  };
  const activity = new ActivityService(store, discord, [], { deliver: false });
  try {
    store.saveSettings(
      { channelId: null, adminRoleId: null, logChannelId: '333333333333333333' },
      actor.userId,
    );
    activity.record(actor, { kind: 'ui.click', target: 'old', summary: 'Old channel' });
    await activity.ingest();
    store.saveSettings(
      { channelId: null, adminRoleId: null, logChannelId: '444444444444444444' },
      actor.userId,
    );
    activity.record(actor, { kind: 'ui.click', target: 'new', summary: 'New channel' });
    await activity.ingest();
    await activity.flush();
    await activity.flush();
    assert.deepEqual(channels, ['333333333333333333', '444444444444444444']);
    assert.equal(activity.list().pending, 1);
  } finally {
    await activity.close();
    store.close();
  }
});
