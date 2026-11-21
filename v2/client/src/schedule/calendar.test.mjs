// #3703: whatson and calendar read the calendar items a world publishes as things, by the numbers and link names
// their kind's entry gives, and name the blank notice `calendar add` posts on.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { publicWordsOf, rememberPublicWords, rowsOf } from '../brief/copy.mjs';
import { encode } from '../history/day.mjs';
import { blankAt, calendarItems, calendarList, heldBlank, noticeBoards, whatsOn, worldTimeOf } from './world.mjs';

const entry = JSON.parse(readFileSync(new URL('../../../../content/kinds/calendar/entry.json', import.meta.url), 'utf8'));
const board = JSON.parse(readFileSync(new URL('../../../../content/kinds/calendar/notice_board.json', import.meta.url), 'utf8'));
const kinds = { [entry.kind]: entry, [board.kind]: board };
const S = new Uint8Array(16).fill(7), id = (n) => [S, n], text = (n) => `${'07'.repeat(16)}-${n}`;
const MIN = 60_000_000, n = (f) => entry.state[f].n;

/** A copy of records by hash: `nodes` as {n, kind, parent, fields, links, children}, the first the root. */
function copyOf(nodes) {
  const store = new Map(), hashOf = new Map();
  for (const x of [...nodes].reverse()) {
    const m = new Map([[1, id(x.n)], [2, x.kind]]);
    if (x.parent) m.set(3, id(x.parent));
    if (x.fields) m.set(6, new Map(x.fields));
    if (x.links) m.set(9, x.links.map(([ty, a, b], k) => [id(900 + x.n * 10 + k), new Map([[1, ty], [2, [id(a), id(b)]]])]));
    const kids = nodes.filter((c) => c.parent === x.n).map((c) => Buffer.from(hashOf.get(c.n), 'hex'));
    if (kids.length) m.set(10, kids);
    const bytes = encode(m), h = createHash('sha256').update(bytes).digest('hex');
    store.set(h, bytes); hashOf.set(x.n, h);
  }
  return { roots: () => JSON.stringify({ root: hashOf.get(nodes[0].n) }), record: (h) => store.get(h) ?? null };
}

const words = (w) => new Map([[21, id(5000)], [23, Buffer.from(w)]]);
// World time is real time (rate 1:1, world µs = real µs); the calendar is UTC with a 24-hour day.
const NOW = 1_800_000_000_000, clock = { world: NOW * 1000, real: NOW * 1000, rate: [1, 1] };
const cal = { day: 86_400n, origin: 0n, offsets: [[0n, 0n]] };
const world = (min) => NOW * 1000 + min * MIN;
const copy = copyOf([
  { n: 1, kind: 'souls:world' },
  { n: 2, kind: 'eden:room', parent: 1 },
  { n: 3, kind: 'eden:room', parent: 1 },
  { n: 10, kind: 'souls:body', parent: 2, links: [['souls:body-of', 10, 100]] },
  { n: 11, kind: 'souls:body', parent: 2, links: [['souls:body-of', 11, 101]] },
  // Posted by Soul 100, on in 30 minutes for an hour, Soul 101 coming.
  { n: 20, kind: 'eden:calendar_entry@abc', parent: 2, fields: [[n('start'), world(30)], [n('end'), world(90)], [n('words'), words('Bread at the oven')]],
    links: [['eden:poster', 100, 20], ['eden:interested', 101, 20]] },
  // On now, words withheld from this copy.
  { n: 21, kind: 'eden:calendar_entry', parent: 3, fields: [[n('start'), world(-10)], [n('end'), world(20)], [n('words'), new Map([[21, id(5001)]])]],
    links: [['eden:poster', 101, 21]] },
  // Next week: not within whatson's hours, but on the calendar.
  { n: 22, kind: 'eden:calendar_entry', parent: 3, fields: [[n('start'), world(7 * 1440)], [n('end'), world(7 * 1440 + 60)], [n('words'), words('Choir')]],
    links: [['eden:poster', 100, 22]] },
  // Over.
  { n: 23, kind: 'eden:calendar_entry', parent: 3, fields: [[n('start'), world(-120)], [n('end'), world(-60)], [n('words'), words('Gone')]],
    links: [['eden:poster', 100, 23]] },
  // A blank notice in room 3.
  { n: 24, kind: 'eden:calendar_entry', parent: 3 },
]);

test('A1: whatson lists what is on now and soon from the published items, and who is where', () => {
  const rows = rowsOf(copy), items = calendarItems(copy, kinds);
  assert.equal(items.length, 5);
  const out = whatsOn(items, { rows, me: text(101), clock, cal, nowMs: NOW, hours: 3 });
  assert.deepEqual(out.on.map((r) => [r.id, r.phase, r.startsInMinutes, r.forMinutes]), [[text(21), 'on', -10, 30], [text(20), 'soon', 30, 60]]);
  const bread = out.on[1];
  assert.equal(bread.title, 'Bread at the oven');
  assert.equal(bread.by, 'body 10');
  assert.equal(bread.place, 'room 2');
  assert.equal(bread.coming, 1);
  assert.equal(bread.youAreComing, true, 'Soul 101 said it would come');
  assert.equal(bread.untrusted, true);
  assert.equal(out.on[0].wordsWithheld, true, 'words the copy was not given are not invented');
  assert.deepEqual(out.souls, [{ place: 'room 2', placeId: text(2), souls: ['body 10', 'body 11'], untrusted: true }]);
  assert.equal(whatsOn(items, { rows, me: text(100), clock, cal, nowMs: NOW, hours: 200 }).on.length, 3, 'a wider window reaches next week');
  const at = new Date(NOW).toISOString();
  assert.deepEqual(worldTimeOf(cal, NOW * 1000), { date: at.slice(0, 10), time: at.slice(11, 16) });
});

test('A2: calendar lists items not over and the blank notices; add finds the blank at a place', () => {
  const rows = rowsOf(copy), items = calendarItems(copy, kinds);
  const out = calendarList(items, { rows, me: text(100), clock, cal, nowMs: NOW });
  assert.deepEqual(out.items.map((r) => r.id), [text(21), text(20), text(22)]);
  assert.deepEqual(out.blank, [{ id: text(24), place: 'room 3', placeId: text(3) }]);
  assert.equal(blankAt(items, rows, text(3))?.id, text(24));
  assert.equal(blankAt(items, rows, text(2)), null, 'no blank notice in room 2');
});

test('A2: the notice boards that make blank notices, and the blank one a body holds', () => {
  const held = copyOf([
    { n: 1, kind: 'souls:world' },
    { n: 2, kind: 'eden:room', parent: 1 },
    { n: 3, kind: 'eden:room', parent: 1 },
    { n: 30, kind: 'eden:notice_board', parent: 2 },
    { n: 31, kind: 'eden:notice_board', parent: 3 },
    { n: 10, kind: 'souls:body', parent: 2 },
    { n: 40, kind: 'eden:calendar_entry', parent: 10 },
    { n: 41, kind: 'eden:calendar_entry', parent: 3 },
  ]);
  const rows = rowsOf(held), items = calendarItems(held, kinds);
  assert.deepEqual(noticeBoards(rows, kinds).map((b) => [b.id, b.form]).sort(), [[text(30), 'take_notice'], [text(31), 'take_notice']]);
  assert.equal(noticeBoards(rows, kinds, text(3))[0].id, text(31), 'the board at the place comes first');
  assert.equal(heldBlank(items, rows, text(10))?.id, text(40));
  assert.equal(heldBlank(items, rows, text(11)), null);
});

test('A2: words beside a records answer reach the copy for public records only', () => {
  const posted = copyOf([
    { n: 1, kind: 'souls:world' },
    { n: 50, kind: 'eden:calendar_entry', parent: 1, fields: [[n('start'), world(5)], [n('end'), world(65)], [n('words'), new Map([[21, id(6000)]])]],
      links: [['eden:poster', 100, 50]] },
  ]);
  const record = (ref, everyone) => encode(new Map([[5, new Map([[1, everyone ? 1 : 2]])], [6, new Map([[n('words'), new Map([[21, id(ref)]])]])]]));
  const frame = encode(new Map([[22, [record(6000, true), record(6001, false)]],
    [27, [[id(6000), Buffer.from('Tea at four')], [id(6001), Buffer.from('a private line')], [id(6002), Buffer.from('named by no record')]]]]));
  rememberPublicWords(posted, frame);
  assert.deepEqual([...publicWordsOf(posted)], [[text(6000), 'Tea at four']], 'a private or unnamed reference gets no words');
  const [item] = calendarItems(posted, kinds);
  assert.equal(item.words, 'Tea at four');
});
