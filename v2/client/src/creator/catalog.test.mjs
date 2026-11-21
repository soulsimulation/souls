// The library of kinds searched on this machine (#3696): catalog, find, recommend and taxonomy answer from the kind
// entries in the home, with no daemon and no server, as today's eden-god's four verbs do.

import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { answer, catalog, libraryOf, recommend, search, taxonomy } from './catalog.mjs';

const GOD = join(dirname(fileURLToPath(import.meta.url)), 'souls-god.mjs');
const entry = (kind, category, card, more = {}) => ({
  format: 'souls-entry/1', kind, owner: 'thing', geometry: { bounds_mm: [500, 900, 500] },
  text: { card, [category]: category, ...(more.text ?? {}) }, card: { text: 'card', category, synonyms: more.synonyms ?? [] },
  ...(more.slots ? { slots: more.slots } : {}), ...(more.forms ? { forms: more.forms } : {}), ...(more.tags ? { looks: { shape: { tags: more.tags } } } : {}),
});
const ENTRIES = [
  entry('eden:camp_chair', 'camp', 'A wooden camp chair: sit on it or carry it.', { synonyms: ['chair'], text: { chair: 'chair' }, slots: { seat: { posture: 'sit' } }, tags: ['seat'] }),
  entry('eden:campfire', 'camp', 'A ring of stones where a fire is laid and lit.', { forms: { light: {}, put_out: {} } }),
  entry('eden:lamp_post', 'light', 'A tall street lamp that lights at dusk.', { synonyms: ['street_lamp'], text: { street_lamp: 'street lamp' } }),
  entry('eden:bench', 'furniture', 'A long wooden bench for three.', { slots: { seat_1: { posture: 'sit' } } }),
];

test('find ranks by name, synonym, tag and card, every word matching, with why', () => {
  const hits = search(ENTRIES, 'chair');
  assert.equal(hits[0].row.kind, 'eden:camp_chair');
  assert.ok(hits[0].why.some((w) => w.startsWith('aka=') || w.startsWith('name')));
  assert.equal(search(ENTRIES, 'street lamp')[0].row.kind, 'eden:lamp_post', 'a phrase synonym names its kind');
  assert.equal(search(ENTRIES, 'benches')[0].row.kind, 'eden:bench', 'plurals find the singular');
  assert.deepEqual(search(ENTRIES, 'chair', { has: 'form:light' }), []);
  assert.deepEqual(search(ENTRIES, 'zzzq'), []);
});

test('catalog filters by category and by what a kind offers', () => {
  assert.equal(catalog(ENTRIES).count, 4);
  assert.deepEqual(catalog(ENTRIES, { category: 'camp' }).rows.map((r) => r.name), ['camp_chair', 'campfire']);
  assert.deepEqual(catalog(ENTRIES, { has: 'slot:sit' }).rows.map((r) => r.name).sort(), ['bench', 'camp_chair']);
});

test('recommend splits a purpose into needs, names what no kind answers, and gives a batch', () => {
  const d = recommend(ENTRIES, 'a fire with a chair and a street lamp and a piano', { root: 7 });
  assert.deepEqual(d.needs.map((n) => n.for), ['street lamp', 'fire', 'chair']);
  assert.deepEqual(d.unmatched, ['piano']);
  assert.deepEqual(d.example.map((o) => [o.op, o.kind, o.in]), [['place', 'eden:lamp_post', 7], ['place', 'eden:campfire', 7], ['place', 'eden:camp_chair', 7]]);
});

test('taxonomy counts categories and what kinds offer', () => {
  const t = taxonomy(ENTRIES);
  assert.equal(t.kinds, 4);
  assert.deepEqual(t.categories[0], { category: 'camp', label: 'camp', count: 2, kinds: ['camp_chair', 'campfire'] });
  assert.equal(t.has.slot['slot:sit'], 2);
  assert.equal(t.has.form['form:light'], 1);
  assert.equal(answer('find', [], ENTRIES).code, 'usage');
  assert.equal(answer('taxonomy', [], []).code, 'no-library');
});

test('souls-god answers the four verbs from the home with no daemon, and only the world it is paired with', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'souls-3696-'));
  const kinds = join(dir, '.souls', 'kinds');
  mkdirSync(kinds, { recursive: true });
  writeFileSync(join(dir, '.souls', 'config.json'), '{}');
  for (const e of ENTRIES) writeFileSync(join(kinds, `${e.kind.replace(':', '.')}.json`), JSON.stringify(e));
  writeFileSync(join(kinds, 'other.piano.json'), JSON.stringify(entry('other:piano', 'music', 'A piano.')));
  const run = (...args) => new Promise((ok) => execFile(process.execPath, [GOD, ...args], { cwd: dir, env: { PATH: process.env.PATH } }, (e, stdout) => ok({ code: e?.code ?? 0, stdout })));
  const found = JSON.parse((await run('find', 'chair')).stdout);
  assert.equal(found.ok, true);
  assert.equal(found.matches[0].kind, 'eden:camp_chair');
  assert.equal(JSON.parse((await run('catalog')).stdout).count, 5, 'without a pairing mark, every entry');
  assert.match((await run('taxonomy', '--lines')).stdout, /^5 kinds\. Categories/);
  assert.match((await run('recommend', 'a', 'campfire', '--lines')).stdout, /- campfire: eden:campfire \[camp\]/);
  // A world's pairing mark lists its own entries: the other world's piano is not this world's.
  writeFileSync(join(kinds, `.entries-${encodeURIComponent('w1')}.json`), JSON.stringify({ files: ENTRIES.map((e) => `${e.kind.replace(':', '.')}.json`) }));
  assert.equal(libraryOf(join(dir, '.souls'), 'w1').length, 4);
  assert.equal(libraryOf(join(dir, '.souls'), undefined).length, 5);
  const none = await run('find', 'zzz', '--lines');
  assert.match(none.stdout, /nothing matches "zzz"/);
});
