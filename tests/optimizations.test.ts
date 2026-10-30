import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.js';
import { loadSeed } from '../src/server/seed.js';
import { publishedRules } from '../src/server/published-rules.js';
import {
  patchBlock,
  withPictureIds,
  moveBlock,
  emptyCollection,
  collectionSchema,
  type Block,
} from '../src/shared/blocks.js';
import { createApp } from '../src/server/app.js';
import { FakeDiscord, testConfig } from './fixtures.js';
import { rulesView } from '../src/server/render.js';

test('published pagination cache reuses a revision, ignores drafts, and refreshes immediately after publication', () => {
  const store = new Store(':memory:', testConfig.guildId, loadSeed());
  try {
    assert.equal(publishedRules(store), null);
    store.commitPublication(loadSeed(), 'admin', '333333333333333333', '555555555555555555');
    const first = publishedRules(store)!;
    assert.strictEqual(publishedRules(store), first);
    const draft = loadSeed();
    draft.rulesets[0].pages[0].body = 'New unpublished rules';
    store.saveDraft(draft, 1, 'admin');
    assert.strictEqual(publishedRules(store), first);
    const cached = rulesView(first.document, 'discord', 0, '666666666666666666', first.pages.discord);
    assert.deepEqual(cached, rulesView(first.document, 'discord', 0, '666666666666666666'));
    store.commitPublication(draft, 'admin', '333333333333333333', '555555555555555555');
    const next = publishedRules(store)!;
    assert.notStrictEqual(next, first);
    assert.equal(next.pages.discord[0].body, 'New unpublished rules');
  } finally {
    store.close();
  }
});

test('upload patches target current block and image IDs after edits, moves and deletion', () => {
  const original: Block[] = [
    {
      id: 'gallery',
      type: 'gallery',
      items: [
        { url: 'https://example.com/1.png', description: 'First', spoiler: false },
        { url: 'https://example.com/2.png', description: 'Second', spoiler: false },
      ],
    },
    { id: 'text', type: 'text', content: 'Original' },
    { id: 'box', type: 'container', color: '#ffffff', spoiler: false, children: [] },
  ];
  let current = withPictureIds(original);
  const gallery = current[0];
  assert.equal(gallery.type, 'gallery');
  if (gallery.type !== 'gallery') return;
  const imageId = gallery.items[1].id;
  current = patchBlock(current, 'text', (block) =>
    block.type === 'text' ? { ...block, content: 'Edited while uploading' } : block,
  );
  current = patchBlock(current, 'gallery', (block) =>
    block.type === 'gallery'
      ? { ...block, items: block.items.slice(1).map((item) => ({ ...item, description: 'New description' })) }
      : block,
  );
  current = moveBlock(current, 'gallery', 'box', 0);
  const finishUpload = () =>
    patchBlock(current, 'gallery', (block) =>
      block.type === 'gallery'
        ? {
            ...block,
            items: block.items.map((item) =>
              item.id === imageId ? { ...item, url: 'https://example.com/uploaded.png' } : item,
            ),
          }
        : block,
    );
  current = finishUpload();
  assert.equal(current[0].type, 'text');
  assert.ok(JSON.stringify(current).includes('Edited while uploading'));
  assert.ok(JSON.stringify(current).includes('New description'));
  assert.ok(JSON.stringify(current).includes('uploaded.png'));
  assert.ok(!JSON.stringify(original).includes('uploaded.png'));
  assert.strictEqual(
    patchBlock(current, 'removed', (block) => block),
    current,
  );
  const collection = emptyCollection();
  collection.messages.push({ ...collection.messages[0] });
  assert.equal(collectionSchema.safeParse(collection).success, false);
});

test('message edits reject simultaneous and stale versions before calling Discord', async () => {
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
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const beginning = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  try {
    const document = emptyCollection();
    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers,
      payload: { requestId: crypto.randomUUID(), channelId: '333333333333333333', document },
    });
    const history = sent.json().history[0];
    discord.editMessage = async () => {
      calls++;
      started();
      await gate;
    };
    const payload = { version: history.version, message: document.messages[0] };
    const first = app
      .inject({ method: 'PUT', url: '/api/messages/' + history.id, headers, payload })
      .then((response) => response);
    await beginning;
    const second = await app.inject({ method: 'PUT', url: '/api/messages/' + history.id, headers, payload });
    assert.equal(second.statusCode, 409);
    assert.equal(calls, 1);
    release();
    const saved = await first;
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().history[0].version, 2);
    const stale = await app.inject({ method: 'PUT', url: '/api/messages/' + history.id, headers, payload });
    assert.equal(stale.statusCode, 409);
    assert.equal(calls, 1);
  } finally {
    release();
    await app.close();
    store.close();
  }
});
