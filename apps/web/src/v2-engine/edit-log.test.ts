// #5006 row 14: God Mode's edit log reads the creator's rows of the public event index (V4), newest first, a page at a
// time, from objects as the world's archiver writes them (`replica::history::events::EventIndex::to_bytes`).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decode as cbor, encode } from 'cborg';
import { creatorRows, editPage, editSlots, editWords, fetchGet, LOOK_BACK_DAYS, type EditRow } from './edit-log.ts';
import { DAY_US, dayCountsKey, eventsKey, yearCountsKey } from './history-keys.ts';
import type { BuildNode } from './creator-build.ts';

const HOUR = 3_600_000_000, MIN = 60_000_000;
const scope = (b: number) => new Uint8Array(16).fill(b);
const id = (b: number, n: number) => [scope(b), n];
const text = (b: number, n: number, sep = '.') => `${Buffer.from(scope(b)).toString('hex')}${sep}${n}`;
const ME = 0xc0, OTHER = 0xc1, WORLD = 0x1a;
const creator = (b: number) => [2, id(b, 1)];
const decode = (b: Uint8Array) => cbor(b, { useMaps: true });

/** An object of the index: rows `[at, kind, node, actor]`, its kinds numbered in order of first use. */
function object(day: number, rows: [number, string, unknown, unknown][], split: number[] = [], hour?: number): Uint8Array {
  const kinds: string[] = [];
  const m = new Map<number, unknown>([[1, 1], [2, day]]);
  if (hour !== undefined) m.set(3, hour);
  m.set(5, rows.map(([at, k, node, actor]) => { if (!kinds.includes(k)) kinds.push(k); return [at, kinds.indexOf(k), node, actor]; }));
  m.set(4, kinds);
  if (split.length) m.set(6, split);
  return encode(m);
}

/** A counts object of a day (`year` false: a slot each ten minutes) or a year (a slot a day) of these rows' times. */
function counts(rows: [number, string, unknown, unknown][], year: boolean): Uint8Array {
  const kinds: string[] = [], by = new Map<string, number>();
  for (const [t, k] of rows) {
    if (!kinds.includes(k)) kinds.push(k);
    const day = Math.floor(t / DAY_US), slot = year ? day % 365 : Math.floor((t - day * DAY_US) / (10 * MIN));
    const key = `${slot} ${kinds.indexOf(k)}`;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return encode(new Map<number, unknown>([[1, 1], [2, year ? 2 : 1], [4, kinds], [5, [...by].map(([k, n]) => [...k.split(' ').map(Number), n])]]));
}

const now = 20_000 * DAY_US + 15 * HOUR, today = 20_000;
const at = (day: number, h: number, m = 0) => day * DAY_US + h * HOUR + m * MIN;
const walked = (day: number, h: number): [number, string, unknown, unknown] => [at(day, h), 'souls:walked', id(WORLD, 9), [1, id(0x2b, 2)]];
// Today: a Soul's act, the creator's place of two things in the cottage (one row a thing) and its move of the bench, a
// set by another creator; hour 13 split off with only Souls' acts, hour 14 with an undo. Yesterday: a removal. Two days
// ago: only a Soul's act. Eight days ago: past the look-back.
const rows = {
  today: [
    walked(today, 9),
    [at(today, 10), 'souls:placed', id(WORLD, 5), creator(ME)],
    [at(today, 10), 'souls:placed', id(WORLD, 5), creator(ME)],
    [at(today, 10), 'souls:moved', id(WORLD, 3), creator(ME)],
    [at(today, 11), 'souls:changed', id(WORLD, 1), creator(OTHER)],
    [at(today, 12), 'souls:weather', id(WORLD, 1), [3]],
  ],
  h13: [walked(today, 13)],
  h14: [[at(today, 14, 5), 'souls:undone', id(WORLD, 7), creator(ME)]],
  yesterday: [[at(today - 1, 20), 'souls:removed', id(WORLD, 8), creator(ME)]],
  twoDaysAgo: [walked(today - 2, 8)],
  past: [[at(today - LOOK_BACK_DAYS, 1), 'souls:placed', id(WORLD, 5), creator(ME)]],
} as Record<string, [number, string, unknown, unknown][]>;
const files = new Map<string, Uint8Array>([
  [eventsKey(today), object(today, rows.today!, [13, 14])],
  [eventsKey(today, 13), object(today, rows.h13!, [], 13)],
  [eventsKey(today, 14), object(today, rows.h14!, [], 14)],
  [eventsKey(today - 1), object(today - 1, rows.yesterday!)],
  [eventsKey(today - 2), object(today - 2, rows.twoDaysAgo!)],
  [eventsKey(today - LOOK_BACK_DAYS), object(today - LOOK_BACK_DAYS, rows.past!)],
  [dayCountsKey(today), counts([...rows.today!, ...rows.h13!, ...rows.h14!], false)],
  [yearCountsKey(Math.floor(today / 365)), counts(Object.values(rows).flat(), true)],
]);
const asked: string[] = [];
const get = async (k: string) => { asked.push(k); return files.get(k) ?? null; };

test('row 14: only a creator\'s rows of an edit\'s kinds, named as the stream and the grant name them; a day names its split hours', () => {
  const { rows, split } = creatorRows(decode(files.get(eventsKey(today))!));
  assert.deepEqual(split, [13, 14]);
  assert.deepEqual(rows.map((r) => [r.kind, r.node, r.creator]), [
    ['souls:placed', text(WORLD, 5), text(ME, 1, '-')],
    ['souls:placed', text(WORLD, 5), text(ME, 1, '-')],
    ['souls:moved', text(WORLD, 3), text(ME, 1, '-')],
    ['souls:changed', text(WORLD, 1), text(OTHER, 1, '-')],
  ]);
  assert.deepEqual(creatorRows(null), { rows: [], split: [] });
});

test('row 14: newest first, a page at a time, one edit a world time and creator, the split hour read, back a week at most', async () => {
  asked.length = 0;
  const cache = new Map<number, EditRow[]>();
  const first = await editPage({ get, decode, now, most: 2, cache });
  assert.deepEqual(first.edits.map((e) => [e.at, e.rows.map((r) => r.kind)]), [
    [at(today, 14, 5), ['souls:undone']],
    [at(today, 11), ['souls:changed']],
  ]);
  assert.equal(first.before, at(today, 11));
  // the year's counts, today's index, its counts and the one split hour with an edit in it
  assert.deepEqual(asked, [yearCountsKey(Math.floor(today / 365)), eventsKey(today), dayCountsKey(today), eventsKey(today, 14)]);
  const second = await editPage({ get, decode, now, before: first.before, most: 2, cache });
  assert.deepEqual(second.edits.map((e) => [e.at, e.rows.map((r) => r.kind)]), [
    [at(today, 10), ['souls:placed', 'souls:placed', 'souls:moved']],
    [at(today - 1, 20), ['souls:removed']],
  ]);
  const third = await editPage({ get, decode, now, before: second.before, most: 2, cache });
  assert.deepEqual(third, { edits: [], before: null }, 'eight days ago is past the look-back');
  assert.ok(!asked.includes(eventsKey(today - LOOK_BACK_DAYS)), 'and never asked for');
  // what is read grows with the edits: a day or a split hour with only Souls' acts is never asked for
  assert.ok(!asked.includes(eventsKey(today - 2)) && !asked.includes(eventsKey(today, 13)));
  assert.deepEqual(editSlots(decode(files.get(dayCountsKey(today))!)).map((s) => Math.floor(s / 6)), [10, 11, 14]);
  assert.deepEqual(editSlots(null), []);
  // A closed day is read once; today is read again each time (the world still writes it).
  assert.equal(asked.filter((k) => k === eventsKey(today - 1)).length, 1);
  assert.equal(asked.filter((k) => k === eventsKey(today)).length, 2);
});

test('row 14: the panel\'s words for each edit, naming things as the stream shows them', async () => {
  const S = Buffer.from(scope(WORLD)).toString('hex');
  const nodes = new Map<string, BuildNode>([
    [`${S}.1`, { id: `${S}.1`, kind: 'eden:world', parent: null }],
    [`${S}.2`, { id: `${S}.2`, kind: 'eden:ground', parent: `${S}.1` }],
    [`${S}.3`, { id: `${S}.3`, kind: 'eden:park_bench@x', parent: `${S}.2` }],
    [`${S}.5`, { id: `${S}.5`, kind: 'eden:cottage@y', parent: `${S}.2` }],
    [`${S}.6`, { id: `${S}.6`, kind: 'souls:place', parent: `${S}.2`, placeName: 'the pond' }],
  ]);
  const { edits } = await editPage({ get, decode, now });
  const words = edits.map((e) => editWords(e, nodes));
  assert.deepEqual(words, ['Undid an edit', 'Changed the world', 'Placed 2 things in the cottage; moved the park bench', 'Removed a thing']);
  const edit = (rows: [string, number][]) => ({ at: 0, creator: '', rows: rows.map(([kind, n]) => ({ kind, node: `${S}.${n}` })) }) as Parameters<typeof editWords>[0];
  assert.equal(editWords(edit([['souls:placed', 2]]), nodes), 'Placed a thing on the ground');
  assert.equal(editWords(edit([['souls:placed', 2], ['souls:placed', 5]]), nodes), 'Placed 2 things');
  assert.equal(editWords(edit([['souls:moved', 3], ['souls:moved', 5], ['souls:moved', 6], ['souls:moved', 2]]), nodes), 'Moved the park bench, the cottage, the pond and 1 more');
  assert.equal(editWords(edit([['souls:redone', 3]]), null), 'Redid an edit');
});

test('row 14: the export\'s objects are fetched beside its history folder; a key it does not hold is none', async () => {
  const seen: string[] = [];
  const go = (async (url: string) => { seen.push(url); return new Response(url.endsWith('/00020000') ? new Uint8Array([1]) : null, { status: url.endsWith('/00020000') ? 200 : 404 }); }) as unknown as typeof fetch;
  const g = fetchGet('https://world.example/s/w/history/', go);
  assert.deepEqual(await g(eventsKey(20_000)), new Uint8Array([1]));
  assert.equal(await g(eventsKey(19_999)), null);
  assert.equal(seen[0], 'https://world.example/s/w/history/history/everyone/events/00020000');
  const broken = fetchGet('https://world.example/s/w/history/', (async () => new Response(null, { status: 500 })) as unknown as typeof fetch);
  await assert.rejects(broken(eventsKey(20_000)));
});
