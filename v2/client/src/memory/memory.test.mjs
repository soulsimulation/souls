// A Soul's memory comes with it (Engine v2 R14, #2754). A home with 30 days of memory, written by the shipping line's
// client, is opened by the v2 client (A1), fed an hour of a new-engine world's named events (A2), and read by `digest`
// and `consolidate` (A3), with a fixture alias table (A4). The home is under the repository's ignored .local/; nothing
// here reads a credentials file. R14_REPORT=1 prints the hashes and the hour's records, for the PR.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openMemoryFolder, PROJECTION_BUDGETS } from '../soul/memory-folder.mjs';
import { openSoulMemory as shippingMemory } from '../soul/memory.mjs';
import { feederFor } from './feeder.mjs';
import { ALIASES, consolidateIn, digestOf, knownThrough, readAliases, soulDirOf } from './memory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const CLI = join(here, '../cli/souls.mjs');
const report = process.env.R14_REPORT === '1';
const WORLD = 'eden', SOUL = 's_r14', DAY = 86_400_000;
const START = Date.parse('2026-10-01T08:00:00.000Z'), CUT = START + 31 * DAY; // 30 days of memory, then the clean start

const home = join(repo, '.local', `r14-${randomBytes(4).toString('hex')}`, '.souls');
const soulDir = soulDirOf(home, SOUL);
after(() => rmSync(dirname(home), { recursive: true, force: true }));

/** sha256 of every file under the Soul's folder, by path. */
function hashes() {
  const out = {};
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else out[relative(soulDir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(soulDir);
  return out;
}
const logLines = () => readFileSync(join(soulDir, 'memory/log/memory-events.jsonl'), 'utf8').split('\n').filter(Boolean);
const peopleFiles = () => readdirSync(join(soulDir, 'memory/people')).sort();

// --- 30 days, written the way the shipping line's client writes them (its wire events, its `remember`) ----------------
// Old ids: Maya and the cafe get aliases at the clean start; Bram and the library do not.
const PLACES = [['cafe', 'Cafe'], ['library', 'Library'], ['square', 'Square']];
let clock = START;
const old = shippingMemory(soulDir, { world: WORLD, soul: SOUL, name: 'Oriel', now: () => new Date(clock).toISOString() });
const PEOPLE = [['maya-old', 'Maya'], ['bram-old', 'Bram']];
for (let day = 0; day < 30; day++) {
  const events = [];
  for (let k = 0; k < 6; k++) {
    clock = START + day * DAY + k * 3_600_000;
    const tick = (day * 6 + k) * 1000 + 1;
    const [place, name] = PLACES[(day + k) % PLACES.length];
    const [pid, pname] = PEOPLE[(day + k) % 2];
    events.push(
      { kind: 'arrive', at: clock, tick, clock: '09:00', where: { placeId: place, place: name } },
      { kind: 'approach', at: clock + 1, tick: tick + 1, from: { soulId: pid, name: pname }, where: { placeId: place, place: name } },
      { kind: 'speech', id: `d${day}-${k}`, at: clock + 2, tick: tick + 2, from: { soulId: pid, name: pname }, text: `Good morning from ${name}, day ${day}.`, where: { placeId: place, place: name } },
      { kind: 'receipt', at: clock + 3, tick: tick + 3, receipt: { id: `r-${day}-${k}`, capability: `sit:${place}`, phase: 'completed', outcome: { summary: `Sat a while at the ${name}.` } } },
    );
  }
  old.sawEvents(events);
  if (day === 3) {
    old.remember('person', 'maya-old', 'Maya reads in the mornings.');
    old.remember('place', 'cafe', 'Quiet before nine.');
    old.remember('self', null, ['I like slow mornings.']);
    old.remember('goal', 'read-more', 'Read one book a week.', { horizon: 'week' });
    old.promise('maya-old', 'Bring her the atlas.');
  }
}
clock = CUT - DAY / 2;
old.brief(); // the shipping line's client last opened it here
const before = hashes();
const recordsBefore = logLines().length;
const peopleBefore = peopleFiles();

// --- The clean start's alias table (a fixture: R18 fills it from X11's table) -------------------------------------------
const MAYA = '7f3a9c-2', CY = '51d0e8-4', CAFE = 'n-9b21';
mkdirSync(home, { recursive: true });
writeFileSync(join(home, ALIASES), JSON.stringify({ version: 'souls-aliases/1', ids: { 'maya-old': MAYA, cafe: CAFE } }));

test('A1: the v2 client opens a 30-day memory and changes no file before the first new event', () => {
  assert.ok(recordsBefore >= 30 * 18, `30 days of records (${recordsBefore})`);
  const feeder = feederFor(home, SOUL, { world: WORLD, name: 'Oriel', now: () => new Date(CUT).toISOString() });
  feeder.memory.brief(); // folds the whole log and writes every projection it would
  knownThrough(soulDir, { aliases: readAliases(home) });
  feeder.feed([]); // an empty batch is not an event
  const after = hashes();
  assert.deepEqual(after, before);
  if (report) console.log(`A1: ${Object.keys(before).length} files, ${recordsBefore} records, every hash unchanged`);
});

// --- An hour in a new-engine world, as named events (T6), with words by reference (T8) ---------------------------------
const TEXT = { 'w:maya': 'Maya', 'w:cy': 'Cy', 'w:cafe': 'Cafe', 'w:pier': 'Pier', 'w:hello': 'Oriel, you came back!', 'w:sat': 'Sat by the window.' };
const at = (min) => min * 60_000_000; // world µs
const HOUR = [
  { sequence: 101, at: at(0), actor: SOUL, events: [{ name: 'souls:arrived', fields: { 1: CAFE, 2: 'w:cafe' } }] },
  { sequence: 102, at: at(3), actor: MAYA, events: [{ name: 'souls:approached', fields: { 1: SOUL, 2: 'w:maya', 3: CAFE, 4: 'w:cafe' } }] },
  { sequence: 103, at: at(4), actor: MAYA, events: [{ name: 'souls:said', fields: { 1: 'w:hello', 2: 'w:maya', 3: CAFE, 4: 'w:cafe' } }] },
  { sequence: 104, at: at(20), actor: SOUL, events: [{ name: 'souls:act-ended', fields: { 1: 'rc-104', 2: 'sit:window', 3: 'completed', 4: 'w:sat', 5: CAFE, 6: 'w:cafe' } }] },
  { sequence: 105, at: at(40), actor: SOUL, events: [{ name: 'souls:arrived', fields: { 1: 'n-pier', 2: 'w:pier' } }] },
  { sequence: 106, at: at(41), actor: CY, events: [{ name: 'souls:approached', fields: { 1: SOUL, 2: 'w:cy', 3: 'n-pier', 4: 'w:pier' } }] },
  // Not this Soul's to remember: another Soul's arrival, a line this Soul said, an event with no reading.
  { sequence: 107, at: at(45), actor: CY, events: [{ name: 'souls:arrived', fields: { 1: CAFE, 2: 'w:cafe' } }] },
  { sequence: 108, at: at(50), actor: SOUL, events: [{ name: 'souls:said', fields: { 1: 'w:hello', 2: 'w:maya' } }] },
  { sequence: 109, at: at(55), actor: null, events: [{ name: 'door-opened', fields: { 1: 'x' } }] },
  { sequence: 110, at: at(58), actor: MAYA, events: [{ name: 'souls:approached', fields: { 1: SOUL, 2: 'w:maya', 3: 'n-pier', 4: 'w:pier' } }] },
];
const realOf = (e) => CUT + Math.floor(e.at / 1000);
const newRecords = () => logLines().slice(recordsBefore).map((l) => JSON.parse(l));

test('A2: an hour in a new-engine world appends valid records once each, and the old validators accept the whole log', () => {
  const feeder = feederFor(home, SOUL, { world: WORLD, name: 'Oriel', textOf: (r) => TEXT[r] ?? null, realOf, now: () => new Date(CUT + 3_600_000).toISOString() });
  feeder.feed(HOUR);
  feeder.feed(HOUR); // a replay, and a resume that sends the same entries again, write nothing
  feeder.feed(HOUR.slice(3));
  const added = newRecords();
  const types = added.map((r) => r.value.type);
  // An arrival, a finished act, a first meeting and a heard line; Maya, met before, is not met again.
  assert.deepEqual(types, ['arrival', 'speech', 'outcome', 'arrival', 'meet']);
  assert.equal(new Set(added.map((r) => r.value.id)).size, added.length);
  for (const r of added) {
    assert.deepEqual(Object.keys(r.value.when).sort(), ['real', 'tick', 'time', 'worldDay']);
    assert.equal(r.value.world, WORLD);
  }
  const speech = added.find((r) => r.value.type === 'speech').value;
  assert.equal(speech.untrusted, true);
  assert.equal(speech.text, 'Oriel, you came back!');
  assert.equal(added.find((r) => r.value.type === 'outcome').value.untrusted, true);
  // The whole log, through the shipping line's own validators: opening it validates every record or throws.
  const known = openMemoryFolder(soulDir, { logs: join('memory', 'log'), personFiles: false, budgets: PROJECTION_BUDGETS }).known();
  assert.ok(known.people.some((p) => p.id === CY && p.name === 'Cy'));
  if (report) console.log(`A2: ${added.length} records added to ${recordsBefore}\n${added.map((r) => JSON.stringify(r.value)).join('\n')}`);
});

test('A3: digest and consolidate run on that home', () => {
  const d = digestOf(soulDir, { since: new Date(CUT - 1).toISOString(), until: new Date(CUT + 3_600_000).toISOString(), refs: true });
  assert.match(d.text, /I met Cy\./);
  assert.match(d.text, /I went to Cafe and Pier\./);
  assert.match(d.text, /Maya said, in their own words: "Oriel, you came back!"/);
  // The commands, on the home by SOULS_HOME: no daemon, no world, no credentials file.
  const env = { ...process.env, SOULS_HOME: home, BRAIN_MODE: 'fake' };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout);
  };
  const digest = run('digest', '--since', new Date(CUT - 1).toISOString());
  assert.equal(digest.ok, true);
  assert.match(digest.text, /I met Cy\./);
  assert.match(run('consolidate', '--force').skipped, /not asked yet/);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ consolidation: { enabled: true } }));
  const pass = run('consolidate', '--force');
  assert.ok(pass.consolidated?.length > 0, JSON.stringify(pass));
  assert.match(readFileSync(join(soulDir, 'MEMORY.md'), 'utf8'), /UNTRUSTED/);
  if (report) console.log(`A3: digest ${digest.words} words; consolidate summarized ${pass.consolidated.length} days`);
});

test('A4: through the alias table a person and a place keep one file; an unaliased old id reads as formerly', () => {
  // Maya, met under her old id for 30 days and again under her new one: one file, the old one, with the new meeting.
  const people = peopleFiles();
  assert.deepEqual(people.filter((f) => !peopleBefore.includes(f)).length, 1, 'only Cy is new');
  const maya = people.find((f) => f.startsWith('eden-maya-old-'));
  assert.ok(maya);
  assert.match(readFileSync(join(soulDir, 'memory/people', maya), 'utf8'), /Oriel, you came back!/);
  assert.ok(!people.some((f) => f.includes(MAYA)));
  // The cafe: one row, its old one, visited again; no row under its new id.
  const places = readFileSync(join(soulDir, 'memory/places.md'), 'utf8');
  assert.equal(places.split('\n').filter((l) => l.startsWith('- eden:cafe ')).length, 1);
  assert.ok(!places.includes(CAFE));
  const known = knownThrough(soulDir, { aliases: readAliases(home), current: (id) => [CY, 'n-pier'].includes(id) });
  const person = (id) => known.people.find((p) => p.id === id || p.was === id);
  const place = (id) => known.places.find((p) => p.id === id || p.was === id);
  assert.deepEqual(person(MAYA), { id: MAYA, name: 'Maya', was: 'maya-old', met: person(MAYA).met });
  assert.equal(person(CY).formerly, undefined);
  assert.equal(person('bram-old').shown, 'Bram (formerly bram-old)');
  assert.equal(place(CAFE).was, 'eden:cafe');
  assert.equal(place('eden:n-pier').formerly, undefined);
  assert.equal(place('eden:library').shown, 'Library (formerly eden:library)');
  // A table that names a new id twice is refused whole.
  writeFileSync(join(home, ALIASES), JSON.stringify({ version: 'souls-aliases/1', ids: { a: MAYA, b: MAYA } }));
  assert.throws(() => readAliases(home), /twice/);
  if (report) console.log(`A4: ${people.length} people files (was ${peopleBefore.length}); Maya ${JSON.stringify(person(MAYA))}; Bram ${JSON.stringify(person('bram-old'))}; cafe ${JSON.stringify(place(CAFE))}; library ${JSON.stringify(place('eden:library'))}`);
});
