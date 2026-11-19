// `memory` and `remember` on the new client (Engine v2 R19, #3327). A home with 30 days of memory, written by the
// shipping line's client, is searched for a person, a place and a line within 200 ms (A3); each kind of `remember`
// writes one record that the record's validators accept on reopening (A4); a line a world wrote reads as untrusted and
// the owner's own lines do not (A5). The home is under the repository's ignored .local/; its credentials file holds a
// made-up token, only so the home knows which world the Soul is in. R19_REPORT=1 prints the timings, for the PR.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openMemoryFolder } from '../../../../tools/world-launcher/soul/memory-folder.mjs';
import { openSoulMemory as shippingMemory } from '../../../../tools/world-launcher/soul/memory.mjs';
import { feederFor } from './feeder.mjs';
import { ALIASES, rememberIn, searchIn, soulDirOf } from './memory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '../cli/souls.mjs');
const report = process.env.R19_REPORT === '1';
const WORLD = 'eden', SOUL = 's_r19', DAY = 86_400_000, START = Date.parse('2026-10-01T08:00:00.000Z');
const home = join(resolve(here, '../../../..'), '.local', `r19-${randomBytes(4).toString('hex')}`, '.souls');
const soulDir = soulDirOf(home, SOUL);
after(() => rmSync(dirname(home), { recursive: true, force: true }));

// --- 30 days, as the shipping line's client writes them ---------------------------------------------------------------
let clock = START;
const old = shippingMemory(soulDir, { world: WORLD, soul: SOUL, name: 'Oriel', now: () => new Date(clock).toISOString() });
const PLACES = [['cafe', 'Cafe'], ['library', 'Library'], ['square', 'Square']], PEOPLE = [['maya-old', 'Maya'], ['bram-old', 'Bram']];
for (let day = 0; day < 30; day++) {
  const events = [];
  for (let k = 0; k < 6; k++) {
    clock = START + day * DAY + k * 3_600_000;
    const tick = (day * 6 + k) * 1000 + 1, [place, name] = PLACES[(day + k) % 3], [pid, pname] = PEOPLE[(day + k) % 2];
    events.push(
      { kind: 'arrive', at: clock, tick, clock: '09:00', where: { placeId: place, place: name } },
      { kind: 'approach', at: clock + 1, tick: tick + 1, from: { soulId: pid, name: pname }, where: { placeId: place, place: name } },
      { kind: 'conversation.turn', id: `d${day}-${k}`, conversation: `cv-${day}-${k}`, at: clock + 2, tick: tick + 2, from: { soulId: pid, name: pname }, text: `Good morning from ${name}, day ${day}.`, where: { placeId: place, place: name } },
      { kind: 'receipt', at: clock + 3, tick: tick + 3, receipt: { id: `r-${day}-${k}`, capability: `sit:${place}`, phase: 'completed', outcome: { summary: `Sat a while at the ${name}.` } } },
    );
  }
  old.sawEvents(events);
  if (day === 3) old.remember('self', null, ['I like slow mornings.']);
}
// The new client's home: a (made-up) token in eden, and Maya's new id at the clean start.
writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { [WORLD]: { token: `soul-${'ab'.repeat(16)}-0.${'cd'.repeat(32)}` } } } }), { mode: 0o600 });
writeFileSync(join(home, ALIASES), JSON.stringify({ version: 'souls-aliases/1', ids: { 'maya-old': 's_maya' } }));

const logLines = () => readFileSync(join(soulDir, 'memory/log/memory-events.jsonl'), 'utf8').split('\n').filter(Boolean);
/** The log reopened through the record's validators (memory-folder.mjs validateEvent / validateRemember); throws on any it refuses. */
const reopen = () => openMemoryFolder(soulDir, { logs: join('memory', 'log'), personFiles: false });
const cli = (...args) => {
  const t = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home }, encoding: 'utf8' });
  return { ...JSON.parse(r.stdout.trim().split('\n').at(-1)), ms: performance.now() - t, code: r.status };
};

test('A3: memory finds a person, a place and a line in a 30-day home in under 200 ms', () => {
  searchIn(home, SOUL, ['warm']); // the first open regenerates the projections, as the shipping line's does
  const timed = {};
  for (const [what, words] of [['person', ['Maya']], ['place', ['Library']], ['line', ['morning', 'day', '29']]]) {
    const t = performance.now(), out = searchIn(home, SOUL, words), ms = performance.now() - t;
    timed[what] = Math.round(ms * 10) / 10;
    assert.ok(out.matches.length > 0, `${what}: ${words.join(' ')} found`);
    assert.ok(ms < 200, `${what}: ${ms} ms`);
  }
  assert.ok(searchIn(home, SOUL, ['morning', 'day', '29']).matches.some((m) => m.text.includes('Good morning from') && m.text.includes('day 29')));
  // And through the command itself, as an agent runs it: a whole process, start to answer.
  const asked = cli('memory', 'Maya');
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.ok(asked.matches.some((m) => m.text.includes('Maya')));
  if (report) console.log(`A3 in-process ms ${JSON.stringify(timed)}; whole command (node start to answer) ${Math.round(asked.ms)} ms; log ${logLines().length} records`);
});

test('A4: each kind of remember writes one record the validators accept', () => {
  const wrote = [];
  const one = (args, check) => {
    const before = logLines().length, out = cli('remember', ...args);
    assert.equal(out.ok, true, `${args.join(' ')}: ${JSON.stringify(out)}`);
    const lines = logLines();
    assert.equal(lines.length, before + 1, `${args[0]} writes one record`);
    const record = JSON.parse(lines.at(-1));
    check(out, record);
    assert.doesNotThrow(reopen, `${args[0]}: the validators accept it`);
    wrote.push(`${args[0]} -> ${record.kind}/${record.value.type ?? Object.keys(record.value).find((k) => ['person', 'place', 'goal', 'self'].includes(k))}`);
    return out;
  };
  // Maya is named by her new id; the record lands on the row she already has.
  one(['--person', 's_maya', 'Maya reads in the mornings.'], (o, r) => { assert.equal(o.name, 'Maya'); assert.equal(r.kind, 'remember'); assert.equal(r.value.note, 'Maya reads in the mornings.'); });
  one(['--place', 'Library', 'Quiet before nine.'], (o, r) => { assert.equal(o.remembered, 'place'); assert.equal(r.value.place, `${WORLD}:library`); });
  one(['--goal', 'read-more', 'Read one book a week.', '--horizon', 'week'], (o, r) => { assert.equal(o.id, 'read-more'); assert.equal(r.value.horizon, 'week'); });
  one(['--self', 'I keep my word.'], (o, r) => { assert.equal(o.remembered, 'self'); assert.ok(r.value.self.includes('I keep my word.')); });
  const promised = one(['--person', 's_maya', '--promise', 'Bring her the atlas.'], (o, r) => { assert.match(o.promised, /^promise:/); assert.equal(r.value.type, 'commitment'); });

  // Maya answers in a conversation, as the new world tells it (T6's souls:said, through R14's feeder).
  clock = START + 31 * DAY;
  const feed = feederFor(home, SOUL, { world: WORLD, textOf: (ref) => ({ t1: 'I will hold you to it.', n1: 'Maya', p1: 'Cafe' })[ref] ?? null, realOf: () => clock + 60_000 });
  feed.feed([{ sequence: 99_001, at: 1, actor: 's_maya', events: [{ name: 'souls:said', fields: { 1: 't1', 2: 'n1', 3: 'cafe', 4: 'p1', 5: 'conv-r19' } }] }]);
  one(['--kept', promised.promised, '--evidence', 'conv-r19'], (o, r) => { assert.equal(o.kept, promised.promised); assert.equal(r.value.type, 'commitment.kept'); });

  // A bad call writes nothing.
  const before = logLines().length;
  assert.equal(cli('remember', '--kept', promised.promised).code, 1);
  assert.equal(cli('remember', '--person', 'nobody-ever', 'hello').code, 1);
  assert.equal(logLines().length, before);
  assert.throws(() => rememberIn(home, SOUL, ['--self']), { code: 'remember-usage' });
  if (report) console.log(`A4 ${wrote.join('; ')}`);
});

test('A5: a line the world wrote reads as untrusted; the owner\'s own lines do not', () => {
  const said = searchIn(home, SOUL, ['Good', 'morning', 'day', '29']).matches;
  assert.ok(said.length > 0 && said.every((m) => m.untrusted === true), JSON.stringify(said.slice(0, 2)));
  for (const words of [['slow', 'mornings'], ['keep', 'my', 'word'], ['Quiet', 'before', 'nine'], ['reads', 'in', 'the', 'mornings']]) {
    const mine = searchIn(home, SOUL, words).matches;
    assert.ok(mine.length > 0, words.join(' '));
    assert.ok(mine.every((m) => m.untrusted === false), `${words.join(' ')}: ${JSON.stringify(mine)}`);
  }
});
