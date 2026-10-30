import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { loadSeed } from '../src/server/seed.js';
import { MediaService } from '../src/server/media.js';
import { FakeDiscord, testConfig } from './fixtures.js';
import {
  emptyCollection,
  emptyMessage,
  messageProblem,
  componentCount,
  type Block,
  moveBlock,
} from '../src/shared/blocks.js';
import { paginate, pageBlocks, infoBlocks } from '../src/shared/rules.js';
import { rulesView, validatePayloads, launcher } from '../src/server/render.js';

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
    store,
    discord,
    app,
    headers,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}
test('public information accepts editable containers, wiki links and the working rules action', async () => {
  const ctx = await fixture();
  try {
    const document = loadSeed();
    document.launcherBlocks = infoBlocks(document);
    document.launcherBlocks.push({
      id: 'resources',
      type: 'container',
      color: '#66aaff',
      spoiler: false,
      children: [
        { id: 'resources-title', type: 'text', content: '## Полезные ссылки' },
        {
          id: 'resources-links',
          type: 'actions',
          buttons: [
            { id: 'wiki', label: 'Вики', url: 'https://example.com/wiki' },
            { id: 'launcher', label: 'Лаунчер', url: 'https://example.com/launcher' },
          ],
        },
      ],
    });
    const json = JSON.stringify(launcher(document));
    assert.ok(json.includes('https://example.com/wiki'));
    assert.ok(json.includes('os:v1:open:'));
    validatePayloads(document);
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/draft',
      headers: ctx.headers,
      payload: { version: 1, document },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    ctx.store.saveSettings({ channelId: '333333333333333333', adminRoleId: null }, 'admin');
    assert.equal(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/publish',
          headers: ctx.headers,
          payload: { version: 2 },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(ctx.store.active()!.launcherBlocks, document.launcherBlocks);
    assert.equal(ctx.store.getSettings().messageId, '555555555555555555');
  } finally {
    await ctx.close();
  }
});
test('legacy rules become editable points and rich images keep their position through pagination', () => {
  const seed = loadSeed();
  const set = seed.rulesets[1];
  const page = set.pages.find((page) => page.title.startsWith('4.'))!;
  const original = structuredClone(page);
  const blocks = pageBlocks(page);
  assert.ok(blocks.length >= 4);
  assert.deepEqual(page, original);
  const gallery: Block = {
    id: 'picture',
    type: 'gallery',
    items: [{ url: 'https://example.com/example.png', description: 'Пояснение к 4.1', spoiler: false }],
  };
  page.blocks = [blocks[0], gallery, ...blocks.slice(1)];
  validatePayloads(seed);
  const views = paginate(set).filter((view) => view.sourceId === page.id);
  assert.equal(views.flatMap((view) => view.blocks)[1].type, 'gallery');
  const index = paginate(set).findIndex((view) => view.sourceId === page.id);
  assert.ok(JSON.stringify(rulesView(seed, 'game', index, '666666666666666666')).includes('example.png'));
  assert.deepEqual(original.body, page.body);
});
test('component counter includes nested sections and buttons, and rejects oversized messages', () => {
  const message = emptyMessage();
  message.blocks = [
    {
      id: 'container',
      type: 'container',
      color: '#5865f2',
      spoiler: false,
      children: [
        {
          id: 'section',
          type: 'section',
          texts: ['Один', 'Два'],
          accessory: { id: 'link', type: 'link', label: 'Читать', url: 'https://example.com' },
        },
        {
          id: 'row',
          type: 'actions',
          buttons: [{ id: 'link2', label: 'Открыть', url: 'https://example.com' }],
        },
      ],
    },
  ];
  assert.equal(componentCount(message.blocks), 7);
  assert.equal(messageProblem(message), null);
  message.blocks = Array.from({ length: 41 }, (_, index) => ({
    id: String(index),
    type: 'text' as const,
    content: 'Правило',
  }));
  assert.ok(messageProblem(message));
});
test('dragging moves blocks into and out of a container without losing content or nesting containers', () => {
  const blocks: Block[] = [
    { id: 'text', type: 'text', content: 'Правило' },
    { id: 'box', type: 'container', color: '#5865f2', spoiler: false, children: [] },
  ];
  const inside = moveBlock(blocks, 'text', 'box', 0);
  assert.equal(inside.length, 1);
  assert.equal(inside[0].type, 'container');
  if (inside[0].type === 'container') assert.equal(inside[0].children[0].id, 'text');
  const outside = moveBlock(inside, 'text', null, 1);
  assert.equal(outside[1].id, 'text');
  assert.deepEqual(moveBlock(inside, 'box', 'box', 0), inside);
});
test('bot sending is authorized, resumes partial batches, deduplicates retries and edits saved message IDs', async () => {
  const ctx = await fixture();
  try {
    const document = emptyCollection();
    document.messages.push(emptyMessage());
    const payload = { requestId: randomUUID(), channelId: '333333333333333333', document };
    assert.equal(
      (await ctx.app.inject({ method: 'POST', url: '/api/messages/send', payload })).statusCode,
      401,
    );
    assert.equal(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/messages/send',
          headers: { cookie: ctx.headers.cookie },
          payload,
        })
      ).statusCode,
      403,
    );
    ctx.discord.failAt = 1;
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers: ctx.headers,
      payload,
    });
    assert.equal(first.statusCode, 502);
    assert.equal(ctx.discord.sent.length, 1);
    ctx.discord.failAt = -1;
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers: ctx.headers,
      payload,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(ctx.discord.sent.length, 2);
    assert.equal(
      (await ctx.app.inject({ method: 'POST', url: '/api/messages/send', headers: ctx.headers, payload }))
        .statusCode,
      200,
    );
    assert.equal(ctx.discord.sent.length, 2);
    const history = second.json().history as { id: number; messageId: string; version: number }[];
    assert.equal(history.length, 2);
    const edited = emptyMessage();
    edited.blocks = [{ id: 'edit', type: 'text', content: 'Исправлено' }];
    const updated = await ctx.app.inject({
      method: 'PUT',
      url: '/api/messages/' + history[0].id,
      headers: ctx.headers,
      payload: { message: edited, version: history[0].version },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().history[0].messageId, history[0].messageId);
    assert.equal(ctx.discord.sent.length, 2);
    const conflict = { ...payload, document: { ...document, title: 'Другой запрос' } };
    assert.equal(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/messages/send',
          headers: ctx.headers,
          payload: conflict,
        })
      ).statusCode,
      409,
    );
  } finally {
    await ctx.close();
  }
});
test('templates and composer drafts save with optimistic versions', async () => {
  const ctx = await fixture();
  try {
    const document = emptyCollection();
    document.title = 'Объявление';
    const save = () =>
      ctx.app.inject({
        method: 'PUT',
        url: '/api/composer',
        headers: ctx.headers,
        payload: { version: 1, document },
      });
    assert.equal((await save()).statusCode, 200);
    assert.equal((await save()).statusCode, 409);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/templates',
      headers: ctx.headers,
      payload: document,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().templates[0].title, 'Объявление');
    assert.equal(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: '/api/templates/' + response.json().templates[0].id,
          headers: ctx.headers,
        })
      ).json().templates.length,
      0,
    );
  } finally {
    await ctx.close();
  }
});
test('image upload is authenticated, validates bytes, survives rule save and becomes a real Discord attachment', async () => {
  const ctx = await fixture();
  let filename: string | undefined;
  try {
    const boundary = 'open-space-test';
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTzUAAAAASUVORK5CYII=',
      'base64',
    );
    const body = Buffer.concat([
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      image,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/media?kind=image',
      headers: { ...ctx.headers, 'content-type': 'multipart/form-data; boundary=' + boundary },
      payload: body,
    });
    assert.equal(response.statusCode, 200, response.body);
    const asset = response.json() as { id: string; url: string };
    const media = new MediaService(ctx.store);
    filename = resolve(media.root, media.get(asset.id).filename);
    assert.equal((await ctx.app.inject(asset.url)).statusCode, 401);
    const served = await ctx.app.inject({ url: asset.url, headers: ctx.headers });
    assert.equal(served.statusCode, 200);
    assert.deepEqual(served.rawPayload, image);
    const seed = loadSeed();
    seed.rulesets[0].pages[0].blocks = [
      ...pageBlocks(seed.rulesets[0].pages[0]),
      { id: 'image', type: 'gallery', items: [{ url: asset.url, description: 'Пояснение', spoiler: false }] },
    ];
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/draft',
      headers: ctx.headers,
      payload: { version: 1, document: seed },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const prepared = media.prepare(rulesView(seed, 'discord', 0, '666666666666666666'));
    assert.equal(prepared.files.length, 1);
    assert.deepEqual(prepared.files[0].attachment, image);
    assert.ok(JSON.stringify(prepared.components).includes('attachment://'));
    assert.throws(() => media.save(Buffer.from('<svg></svg>'), 'fake.png', true, 'admin'));
  } finally {
    await ctx.close();
    if (filename) unlinkSync(filename);
  }
});
