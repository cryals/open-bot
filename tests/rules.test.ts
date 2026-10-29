import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, documentSchema } from '../src/shared/rules.js';
import { loadSeed } from '../src/server/seed.js';
import { launcher, rulesView, validatePayloads } from '../src/server/render.js';

test('seed imports logical blocks and every generated page fits Components V2', () => {
  const seed = loadSeed();
  assert.equal(seed.rulesets[0].pages.length, 6);
  assert.equal(seed.rulesets[1].pages.length, 12);
  validatePayloads(seed);
  const message = launcher(seed);
  assert.equal(message.flags, 32768);
  assert.equal('embeds' in message, false);
  assert.equal(JSON.parse(JSON.stringify(message.components[0])).type, 17);
});
test('long Unicode rules split without losing content and retain intro and user ownership', () => {
  const seed = loadSeed();
  const set = seed.rulesets[0];
  const body = 'Правило 👩‍🚀漢字\n\n'.repeat(850).trim();
  set.pages = [{ id: 'long', title: 'Большой раздел', body, enabled: true }];
  const pages = paginate(set);
  assert.ok(pages.length > 3);
  assert.equal(
    pages
      .map((page) => page.body)
      .join('')
      .replace(/\s/g, ''),
    body.replace(/\s/g, ''),
  );
  validatePayloads(seed);
  for (let index = 0; index < pages.length; index++) {
    const serialized = JSON.stringify(rulesView(seed, 'discord', index, '123456789123456789'));
    assert.ok(serialized.includes(set.intro));
    assert.ok(serialized.includes('os:v1:menu:123456789123456789'));
    assert.ok(Buffer.byteLength(serialized) < 10000);
    assert.ok(!pages[index].body.includes('\ufffd'));
  }
});
test('rejects duplicate page IDs, hidden entire ruleset and swapped rule types', () => {
  const seed = loadSeed();
  seed.rulesets[0].pages[1].id = seed.rulesets[0].pages[0].id;
  assert.equal(documentSchema.safeParse(seed).success, false);
  const hidden = loadSeed();
  hidden.rulesets[0].pages.forEach((page) => {
    page.enabled = false;
  });
  assert.equal(documentSchema.safeParse(hidden).success, false);
  const reversed = loadSeed();
  reversed.rulesets.reverse();
  assert.equal(documentSchema.safeParse(reversed).success, false);
});
