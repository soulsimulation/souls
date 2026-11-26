// #5006 rows 7 and 9: Build's whole catalogue (the kinds the world pins, searched by their entries' words) and its turn.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encode } from 'cborg';
import { catalogueOf, headerKinds, oneForm, pinnedKinds, searchKinds, turned } from './creator-catalogue.ts';

const H = (n: number) => '1220' + String(n).padStart(2, '0').repeat(32);
const PINNED = [`eden:world@${H(1)}`, `eden:ground@${H(2)}`, `eden:park_bench@${H(3)}`, `eden:armchair@${H(4)}`, `eden:cottage@${H(5)}`,
  `eden:humanoid@${H(6)}`, `souls:kind@${H(7)}`, `eden:hug_activity@${H(8)}`, `eden:campfire@${H(9)}`, `eden:benches_set@${H(10)}`, `eden:lawn_room@${H(11)}`];
const entry = (kind: string, owner: string, card: Record<string, unknown> = {}, text: Record<string, string> = {}) => ({ format: 'souls-entry/1', kind, owner, card, text });
const ENTRIES = [
  entry('eden:park_bench', 'thing', { text: 'card', category: 'garden', synonyms: ['seat'] }, { card: 'A wooden bench to sit on in the park.', garden: 'garden', seat: 'seat' }),
  entry('eden:armchair', 'thing', { text: 'card', category: 'furniture' }, { card: 'A soft chair with arms.', furniture: 'furniture' }),
  entry('eden:campfire', 'thing', { text: 'card', category: 'camp', synonyms: ['bonfire'] }, { card: 'Logs to light and sit around.', camp: 'camp', bonfire: 'bonfire' }),
  entry('eden:lawn_room', 'place'),
  { format: 'souls-activities/1', activities: [] },
];

test('the pinned kinds are the header\'s field 6, full names only', async () => {
  const header = new Map<number, unknown>([[1, new Uint8Array(34)], [6, [...PINNED, 'eden:unpinned']], [7, []]]);
  assert.deepEqual(headerKinds(header), PINNED);
  assert.deepEqual(headerKinds(new Map()), []);
  const bytes = encode(header);
  const get = (async (url: string) => (url === 'h' ? new Response(bytes) : new Response('', { status: 404 }))) as typeof fetch;
  assert.deepEqual(await pinnedKinds('h', get), PINNED, 'read as the page reads it');
  assert.deepEqual(await pinnedKinds('gone', get), [], 'a header not served is no kinds, not an error');
  assert.deepEqual(await pinnedKinds(null, get), []);
});

test('the catalogue is every pinned thing: an entry\'s owner says which; without one, its name', () => {
  const kinds = catalogueOf(PINNED, ENTRIES).map((k) => k.kind.split('@')[0]);
  assert.deepEqual(kinds, ['eden:armchair', 'eden:benches_set', 'eden:campfire', 'eden:cottage', 'eden:park_bench'],
    'no world, ground, body, engine kind, activity or place; a cottage with no entry is a thing');
  assert.deepEqual(catalogueOf(PINNED, null).map((k) => k.name), ['armchair', 'benches set', 'campfire', 'cottage', 'lawn room', 'park bench'],
    'without entries, by name alone');
  const mine = `me:lamp@${H(12)}`, standing = `eden:hut@${H(13)}`;
  assert.deepEqual(catalogueOf(PINNED, ENTRIES, [mine, standing, `eden:park_bench@${H(3)}`]).filter((k) => k.kind === mine || k.kind === standing).length, 2,
    'a creator\'s own kind and one standing in the world are offered too, once');
  assert.equal(catalogueOf(PINNED, ENTRIES).find((k) => k.name === 'park bench')?.card, 'A wooden bench to sit on in the park.');
});

test('a search finds by name, synonym, category and card, every word, the name first', () => {
  const list = catalogueOf(PINNED, ENTRIES);
  const names = (q: string) => searchKinds(list, q).map((k) => k.name);
  assert.deepEqual(names('bench'), ['park bench', 'benches set'], 'a whole word of the name first, then a word that starts with it');
  assert.deepEqual(names('benches'), ['park bench', 'benches set'], 'by its singular');
  assert.deepEqual(names('seat'), ['park bench'], 'a synonym');
  assert.deepEqual(names('bonfire'), ['campfire']);
  assert.deepEqual(names('furniture'), ['armchair'], 'a category');
  assert.deepEqual(names('soft chair'), ['armchair'], 'card words, every one');
  assert.deepEqual(names('park sofa'), [], 'every word must match');
  assert.equal(names('').length, list.length, 'nothing typed: every kind');
});

const Q = 2 ** 30;
test('a turn is the one form the world reads: 90 degrees is the fixtures\' turn, 24 of 15 degrees come back to none', () => {
  assert.deepEqual(turned([Q, 0, 0, 0], Math.PI / 2), [759250125, 0, 759250125, 0], 'v2/crates/replica/fixtures/pose/boat.diag');
  assert.deepEqual(turned([Q, 0, 0, 0], -Math.PI / 2), [759250125, 0, -759250125, 0]);
  assert.deepEqual(turned([0, 0, Q, 0], Math.PI), [Q, 0, 0, 0], 'the first number never negative: a half turn of a half turn is none');
  let r = [Q, 0, 0, 0];
  for (let i = 0; i < 24; i++) r = turned(r, Math.PI / 12);
  assert.deepEqual(r, [Q, 0, 0, 0]);
  assert.deepEqual(oneForm([-3n, 0n, 0n, 0n]).map(Number), [Q, 0, 0, 0], 'a multiple of a direction is its multiple nearest one');
});
