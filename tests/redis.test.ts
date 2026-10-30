import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { RedisActivityStream, type ActivityEvent } from '../src/server/activity-queue.js';

const url = process.env.TEST_REDIS_URL;
test(
  'real Redis recovers unacknowledged activity after consumer restart and deletes confirmed entries',
  { skip: !url, timeout: 15000 },
  async () => {
    const key = 'open-bot:test:' + crypto.randomUUID();
    const errors: unknown[] = [];
    let stream = new RedisActivityStream(url!, key, (error) => errors.push(error));
    const waitReady = async () => {
      for (let attempt = 0; attempt < 40 && !stream.ready(); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(stream.ready(), true, 'Redis must be ready for the integration test');
    };
    const event: ActivityEvent = {
      eventId: crypto.randomUUID(),
      createdAt: Date.now(),
      actor: 'test',
      actorName: 'Test',
      kind: 'ui.click',
      target: 'button',
      summary: 'Integration',
      details: {},
      before: null,
      after: null,
      diff: null,
    };
    try {
      await waitReady();
      await stream.append([event]);
      const pending = await stream.read();
      assert.equal(pending.length, 1);
      stream.close();
      stream = new RedisActivityStream(url!, key, (error) => errors.push(error));
      await waitReady();
      const replay = await stream.read();
      assert.equal(replay[0].id, pending[0].id);
      assert.equal(JSON.parse(replay[0].message.event).eventId, event.eventId);
      await stream.acknowledge(replay.map((entry) => entry.id));
      assert.deepEqual(await stream.read(), []);
      assert.equal(errors.length, 0);
    } finally {
      stream.close();
      const cleanup = createClient({ url, socket: { connectTimeout: 1000, reconnectStrategy: false } });
      cleanup.on('error', () => {});
      try {
        await cleanup.connect();
        await cleanup.del(key);
      } finally {
        if (cleanup.isOpen) cleanup.destroy();
      }
    }
  },
);
