// Asking what happened (Engine v2 R16, #2817) on a recorded stretch of Eden in V4's files (`day.mjs`), served over
// HTTP as a world's history is. The daemon's end of it, through the thin command, is in `../cli/souls.test.mjs`.
// R16_REPORT=1 prints the three answers with their times and bytes, for the PR.
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { DAY, LOOK_BACK_MOST, history, when } from './history.mjs';
import { getter, objects, script, serve, soulId } from './day.mjs';

const MOST_BYTES = 600, MOST_MS = 2000;
// The daemon adds `at` and `age` (with a gap, when stale) to the answer: counted in, at their longest.
const DAEMON_ADDS = Buffer.byteLength(',"at":9007199254740991,"age":9007199254740991,"stale":true,"gap":{"ms":9007199254740991,"why":"not-connected"}');
const ME = soulId(1), KOFI = soulId(42);

let s, srv, get, end;
const counted = { bytes: 0, requests: 0 };
before(async () => {
  s = script({ souls: 100, perMinute: 1, days: 9 });
  srv = await serve(objects(s.acts));
  const http = getter(srv.base);
  get = async (k) => { const b = await http(k); counted.requests++; counted.bytes += b?.length ?? 0; return b; };
  end = (Math.floor(s.acts.at(-1).at / DAY) + 1) * DAY;
});
after(() => srv.stop());

/** What the script says happened for a question in [from, to]: its rows by kind, newest first. */
function truth(match, from, to) {
  const rows = s.acts.filter((a) => a.at >= from && a.at <= to && match(a));
  const kinds = {};
  for (const r of rows) { const k = r.kind.replace(/^souls:/, ''); kinds[k] = (kinds[k] ?? 0) + 1; }
  return { found: rows.length, kinds, newest: rows.slice(-5).reverse() };
}

const memory = [
  { kind: 'event', value: { at: '2026-11-18T09:00:00.000Z', type: 'speech', personId: KOFI, text: 'you took my bike yesterday', untrusted: true } },
  { kind: 'event', value: { at: '2026-11-18T09:01:00.000Z', type: 'told', personIds: [KOFI], text: 'sorry, I will bring it back' } },
  { kind: 'event', value: { at: '2026-11-18T09:02:00.000Z', type: 'meet', person: { id: KOFI, name: 'Kofi' } } },
];
const names = new Map([[KOFI, 'Kofi']]);

test('A1, A2: by place, by thing and by Soul, each under 2 s and 600 bytes, and each the script\'s count, kinds and newest', async () => {
  const room = s.room, desk = s.things(room)[0], inRoom = new Set([room, ...s.things(room)]);
  const asks = [
    ['place', { by: 'place', id: room }, (a) => inRoom.has(a.node)],
    ['thing', { by: 'thing', id: desk }, (a) => a.node === desk],
    ['soul', { by: 'soul', id: KOFI }, (a) => a.actor === KOFI || a.node === KOFI],
  ];
  for (const [what, ask, match] of asks) {
    counted.bytes = counted.requests = 0;
    const t0 = performance.now();
    const a = await history(ask, { get, rows: s.rows, names, memory, me: ME });
    const ms = performance.now() - t0, bytes = Buffer.byteLength(JSON.stringify(a)) + DAEMON_ADDS;
    assert.ok(ms < MOST_MS, `${what}: ${Math.round(ms)} ms`);
    assert.ok(bytes < MOST_BYTES, `${what}: ${bytes} bytes`);
    const t = truth(match, end - DAY, end);
    assert.equal(a.found, t.found, what);
    assert.deepEqual(a.kinds, t.kinds, what);
    assert.deepEqual(a.span, { from: when(end - DAY), to: when(end) });
    assert.equal(a.more, a.found - a.lines.length);
    // Each line is a row of the script, newest first: its time, and whoever and wherever it names.
    a.lines.forEach((line, k) => assert.ok(line.startsWith(when(t.newest[k].at)), `${what}: ${line}`));
    if (what === 'thing') a.lines.forEach((line, k) => assert.ok(line.includes(s.rows.get(t.newest[k].actor).name), line));
    if (process.env.R16_REPORT) console.log(JSON.stringify({ question: what, ms: Math.round(ms), answerBytes: bytes, fetched: counted.bytes, requests: counted.requests, answer: a }));
  }
});

test('A3: a question beyond the look-back says so, with its span and what it left out', async () => {
  const since = end - 9 * DAY;
  const a = await history({ by: 'thing', id: s.things(s.room)[0], since }, { get, rows: s.rows, me: ME });
  assert.deepEqual(a.span, { from: when(end - LOOK_BACK_MOST * DAY), to: when(end) }, 'seven days at most');
  const left = s.acts.filter((r) => r.at >= since && r.at < end - LOOK_BACK_MOST * DAY).length;
  assert.deepEqual(a.beyond, { asked: when(since), mostDays: LOOK_BACK_MOST, leftOut: { days: 2, daysWithEvents: 2, publicEvents: left } });
  // Within the look-back there is nothing beyond it to say.
  assert.equal((await history({ by: 'thing', id: s.things(s.room)[0], since: end - 3 * DAY }, { get, rows: s.rows, me: ME })).beyond, undefined);
});

test('A4: no answer carries words the asker did not hear; what it heard comes from its own memory', async () => {
  // A thing whose copy row quotes words (a sign): names come from the copy, its quoted text never does.
  const sign = s.things(s.room)[1];
  const rows = new Map(s.rows);
  rows.set(sign, { ...rows.get(sign), text: ['the words on the sign'] });
  const asks = [{ by: 'place', id: s.room }, { by: 'thing', id: sign }, { by: 'soul', id: KOFI }, { by: 'soul', id: ME }];
  for (const ask of asks) {
    const text = JSON.stringify(await history(ask, { get, rows, names, memory, me: ME }));
    assert.ok(!text.includes('the words on the sign'), ask.by);
    // Only the memory lines quote, and only what the asker heard or said.
    const quoted = [...text.matchAll(/\\"([^\\]*)\\"/g)].map((m) => m[1]);
    for (const q of quoted) assert.ok(['you took my bike yesterday', 'sorry, I will bring it back'].includes(q), `${ask.by}: ${q}`);
  }
  // By Soul: the asker's own memory first, with the words it heard (marked UNTRUSTED) and said.
  const kofi = await history({ by: 'soul', id: KOFI }, { get, rows: s.rows, names, memory, me: ME });
  assert.equal(kofi.about, 'Kofi');
  assert.deepEqual(kofi.memory, ['2026-11-18 09:02 met Kofi', '2026-11-18 09:01 I said: "sorry, I will bring it back"']);
  assert.equal(kofi.memoryMore, 1);
});
