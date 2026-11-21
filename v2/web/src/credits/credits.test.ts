// N-W7 (#3693): the credits page from the licence records, and the check that every baked model is credited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { creditsHtml, uncredited, type Records } from './credits.ts';

const records = JSON.parse(readFileSync(new URL('../../../../tools/cdn/approved-derivatives.json', import.meta.url), 'utf8')) as Records;
const template = readFileSync(new URL('../../credits.html', import.meta.url), 'utf8');

test('A1: the page lists every source with its licence and link, the files made from it, and our own models', () => {
  const html = creditsHtml(template, records);
  assert.ok(!html.includes('<!--credits-->'));
  for (const [name, files] of Object.entries(records.sources)) {
    assert.ok(html.includes(name.replace(/&/g, '&amp;')), name);
    for (const f of files) {
      assert.ok(html.includes(f.licence));
      if (f.url) assert.ok(html.includes(`href="${f.url.replace(/&/g, '&amp;')}"`), f.url);
    }
  }
  for (const d of records.derivatives) assert.ok(html.includes(d.path), d.path);
  assert.ok(html.includes(`${records.generated!.models.length} models are drawn by Souls' own mesh builders`));
  assert.match(html, /Quaternius/);
  assert.match(html, /Kenney/);
  assert.throws(() => creditsHtml('<html></html>', records), /marker/);
});

test('A1: record text is escaped', () => {
  const html = creditsHtml('<!--credits-->', { sources: { 'a <b>': [{ path: 'x/y.zip', licence: 'CC0-1.0', url: 'javascript:alert(1)' }] }, derivatives: [] });
  assert.ok(html.includes('a &lt;b&gt;') && !html.includes('javascript:'));
});

test('A2: a baked model with no record is found; recorded ones pass', () => {
  const own = records.generated!.models[0].path.split('/').pop()!.replace(/\.glb$/, '');
  assert.deepEqual(uncredited({ things: { e_1: own, e_2: null }, kinds: [{ model: own }] }, records), []);
  assert.deepEqual(uncredited({ things: { e_1: own, e_3: '1220ffff' } }, records), ['1220ffff']);
});
