// #1981: what the eight-hour run's memory got wrong, replayed from an event sequence like the run's (Mira and her five
// neighbours, report A3 mismatches 1–8 and A4 items 2, 5, 6 and 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTLE_MS, openSoulMemory } from './soul/memory.mjs';

const T0 = Date.parse('2026-11-11T21:27:00.000Z'), TPS = 20;
const tmp = (t) => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'souls-day-'))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const read = (dir, f) => readFileSync(join(dir, "memory", f), "utf8").replace(/\\(.)/g, "$1");   // markdown escapes off, to read as a mind does
const journal = (dir) => readdirSync(join(dir, 'memory/journal')).sort().map((f) => read(dir, `journal/${f}`)).join('\n');
const person = (dir, name) => { const f = readdirSync(join(dir, 'memory/people')).find((x) => read(dir, `people/${x}`).startsWith(`# ${name} `)); return f ? read(dir, `people/${f}`) : null; };
const placeLine = (dir, id) => read(dir, 'places.md').split('\n').find((l) => l.startsWith(`- eden:${id} `)) ?? '';

/** A clock the test moves: real time and world ticks go together. */
function day(t) {
  const dir = tmp(t); let ms = T0;
  const m = openSoulMemory(dir, { world: 'eden', url: 'https://x.test/w/eden', soul: 's_mira', name: 'Mira', now: () => new Date(ms).toISOString() });
  const at = (s) => { ms = T0 + s * 1000; return { at: ms, tick: 1000 + s * TPS }; };
  const ev = (s, e) => { const w = at(s); m.sawEvents([{ id: `c_${s}_${e.kind}`, ...w, ...e }]); };
  const live = (s, place) => { at(s); return m.sawPlace({ place, name: () => ({ field: 'Green field', stage: 'Village Performance Stage', hall: 'Main Hall', dining: 'Commons Dining Area' })[place], tick: 1000 + s * TPS }); };
  const from = (soulId, name) => ({ soulId, name });
  return { dir, m, at, ev, live, from };
}

test('A1: a place the body is in without a walk is visited; every arrival counts, repeated ones included', (t) => {
  const { dir, m, ev, live, at } = day(t);
  live(0, 'field'); assert.equal(live(SETTLE_MS / 1000, 'field'), true, 'the place the body started in, once the picture keeps it there');
  ev(7200, { kind: 'arrive', where: { placeId: 'dining', place: 'Commons Dining Area' } });                                           // wake 3's walk
  ev(10800, { kind: 'arrive', where: { placeId: 'dining', place: 'Commons Dining Area' } });                                          // wake 4: the same place again
  ev(10800, { kind: 'arrive', where: { placeId: 'dining', place: 'Commons Dining Area' } });                                          // a replay adds nothing
  ev(14400, { kind: 'arrive', where: { placeId: 'stage', place: 'Village Performance Stage' } });
  live(14405, 'hall'); live(14410, 'stage');                                                                                         // passing by is no arrival
  ev(18000, { kind: 'arrive', where: { placeId: 'stage', place: 'Village Performance Stage' } });
  live(18100, 'hall'); assert.equal(live(18100 + SETTLE_MS / 1000, 'hall'), true, 'moved about 10 m, by no act of its own');
  live(18200, 'hall');
  assert.match(placeLine(dir, 'dining'), /visits 2 \|/); assert.match(placeLine(dir, 'stage'), /visits 2 \|/);
  assert.match(placeLine(dir, 'hall'), /visits 1 \|/); assert.match(placeLine(dir, 'field'), /visits 1 \|/);
  assert.equal(journal(dir).match(/Arrived at Commons Dining Area/g).length, 2);
  at(18300);
  assert.match(m.brief(), /This place:\n- "Main Hall": first time here\./);
  // `here` read before the walk's own arrive event reaches the stream: one arrival, not two
  m.sawHere({ tick: 1000 + 21600 * TPS + 5, clock: '03:27', now: '· world day 1', me: { place: 'dining', placePath: ['Commons Dining Area'] }, near: [] });
  ev(21600, { kind: 'arrive', where: { placeId: 'dining', place: 'Commons Dining Area' } });
  assert.match(placeLine(dir, 'dining'), /visits 3 \|/);
});

test('A1: a meeting and a last contact record the place the Souls were in, never "at null"', (t) => {
  const { dir, ev, live, from } = day(t);
  ev(0, { kind: 'approach', from: from('s_ana', 'Ana'), where: { placeId: 'field', place: 'Green field', dist: 3 } });               // before memory had any place
  ev(1, { kind: 'approach', from: from('s_bo', 'Bo') });                                                                            // a world that says nothing of where
  live(18000, 'hall'); live(18000 + SETTLE_MS / 1000, 'hall');
  ev(27900, { kind: 'speech', from: from('s_bo', 'Bo'), text: 'Anyone know a good song?', where: { placeId: 'hall', place: 'Main Hall' } });
  const j = journal(dir);
  assert.match(j, /Confirmed physical meeting with Ana \[s_ana\] at Green field/);
  assert.match(j, /Confirmed physical meeting with Bo \[s_bo\] \(eden/, 'no place known is said by saying none');
  assert.doesNotMatch(j, /at null/);
  assert.match(person(dir, 'Ana'), /## First met[^\n]*\n- [^\n]* at Green field/);
  assert.match(person(dir, 'Bo'), /## Last contact[^\n]*\n- [^\n]* at Main Hall/);
});

test('A2: a person\'s quotes are each kept once, and a line said to the Soul is kept ahead of ambient ones', (t) => {
  const { dir, ev, from } = day(t), ana = from('s_ana', 'Ana');
  ev(0, { kind: 'approach', from: ana, where: { placeId: 'field', place: 'Green field' } });
  ev(60, { kind: 'speech', from: ana, text: 'Lovely light today.' });
  ev(311, { kind: 'speech', from: ana, text: 'Nice to meet you, Mira! I host tea most mornings, come by.' });
  ev(900, { kind: 'speech', from: ana, text: 'Has anyone seen the garden lately?' });
  ev(1800, { kind: 'speech', from: ana, text: 'Lovely light today.' });
  ev(2700, { kind: 'speech', from: ana, text: 'I am putting the kettle on soon.' });
  ev(3600, { kind: 'speech', from: ana, text: 'Lovely light today.' });
  const said = person(dir, 'Ana').split('## What they said')[1].split('\n').filter((l) => l.startsWith('> '));
  assert.deepEqual(said, ['> Nice to meet you, Mira! I host tea most mornings, come by.', '> Has anyone seen the garden lately?', '> Lovely light today.']);
});

test('A3: calendar interest and invitations heard and made are promises with who, what, when and source; the brief shows them; the journal has the Soul\'s own speech', (t) => {
  const { dir, m, ev, at, from } = day(t), bo = from('s_bo', 'Bo'), esi = from('s_esi', 'Esi');
  ev(0, { kind: 'approach', from: bo, where: { placeId: 'field', place: 'Green field' } });
  ev(1, { kind: 'approach', from: esi, where: { placeId: 'field', place: 'Green field' } });
  ev(300, { kind: 'speech', saidId: 'sp_bo1', from: bo, text: 'Hey Mira, I play music in the evening. You should come.', where: { placeId: 'field', place: 'Green field' } });
  ev(301, { kind: 'speech', saidId: 'sp_bo2', from: bo, text: 'Music tonight, everyone is welcome.' });                              // not to Mira: no promise
  at(7200);
  m.sawCalendar({ id: 'cal-zgsqs8yc', title: 'Music night', placeId: 'stage', place: 'Village Performance Stage', startsInMinutes: 180, byId: 's_bo' });
  m.sawSaid('Esi, want to come to the music with me tonight?', { id: 'sp_mira1' });
  m.sawSaid('Lovely evening.', { id: 'sp_mira2' });
  const promises = read(dir, 'promises.md');
  assert.match(promises, /Said I will come: Music night at Village Performance Stage, starts 2026-11-12T02:27:00\.000Z \[eden:cal-zgsqs8yc\]/);
  assert.match(promises, /Bo invited me: Hey Mira, I play music in the evening\. You should come\. \[eden:sp_bo1\]/);
  assert.match(promises, /I invited Esi: Esi, want to come to the music with me tonight\? \[eden:sp_mira1\]/);
  assert.doesNotMatch(promises, /everyone is welcome/);
  const j = journal(dir);
  assert.match(j, /Said to Esi: Esi, want to come to the music with me tonight\?/);
  assert.match(j, /Said: Lovely evening\./, 'said to no one it knows, and still journalled');
  at(7260);
  const brief = m.brief().split('Coming up:\n')[1];
  assert.match(brief, /^- \[eden:cal-zgsqs8yc\] I said I'd come: "Music night" at "Village Performance Stage", starts in 179 min$/m);
  assert.match(brief, /^- \[eden:sp_mira1\] I invited "Esi": Esi, want to come to the music with me tonight\?$/m);
  assert.match(brief, /^- \[eden:sp_bo1\] "Bo" invited me: "Hey Mira, I play music in the evening\. You should come\."$/m);
  at(7200 + 5 * 3600);
  assert.doesNotMatch(m.brief(), /Music night/, 'an hour after it started, it is no longer coming up');
});

// The client's own hooks: `calendar interest` reads the item off the world's calendar, and `say` keeps the world's speech id.
test('A3: through the CLI, calendar interest and say reach memory', async (t) => {
  const seen = [];
  let made = false;
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const path = req.url.replace(/^\/w\/a/, '').split('?')[0], body = raw ? JSON.parse(raw) : {}, send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      seen.push(`${req.method} ${path}`);
      if (path === '/v1/config') return send(200, { devAuth: true, worldId: 'w_a', worldName: 'World a' });
      if (path === '/v1/souls') { made = true; return send(200, { soul: { id: 's_a1', name: body.name } }); }
      if (path === '/v1/souls/s_a1/pair') return send(200, { code: 'code-s_a1' });
      if (path === '/v1/agent/pair') return send(200, { token: 'sim_s_a1_x' });
      if (path === '/v1/me') return send(200, { souls: made ? [{ id: 's_a1', name: 'Mira' }] : [] });
      if (path === '/v1/agent/me') return send(200, { soul: { id: 's_a1', name: 'Mira' }, inbox: {} });
      if (path === '/v1/edge/here') return send(200, { here: { tick: 50, clock: '21:30', now: '· world day 1', me: { soulId: 's_a1', name: 'Mira', place: 'field', placePath: ['Green field'] }, near: [] } });
      if (path === '/v1/edge/objects/cal-1/act') return send(200, { accepted: true, object: 'cal-1', action: body.action });
      if (path === '/v1/edge/calendar') return send(200, { tick: 1000, items: [{ id: 'cal-1', title: 'Morning tea', placeId: 'dining', placeName: 'Commons Dining Area', startsAtTick: 1000 + 90 * 1200, endsAtTick: 1000 + 150 * 1200, proposedBy: 'Ana', interested: [], phase: 'upcoming', untrusted: true }] });
      if (path === '/v1/edge/say') return send(200, { said: { id: 'sp_42', tick: 60, heardBy: 0 } });
      send(404, { code: 'no-route', path });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dir = tmp(t), soul = join(dir, '.souls/souls/s_a1'), cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
  const run = (...args) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { ...process.env, HOME: dir, SOULS_HOME: '', SOULS_PRINCIPAL: '', EDEN_TIME_SCALE: '0.01' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (c) => { out += c; }); child.on('exit', (code) => done({ code, out }));
  });
  await run('register', `http://127.0.0.1:${server.address().port}/w/a`); await run('create', 'Mira'); await run('here');
  assert.equal((await run('calendar', 'interest', 'cal-1')).code, 0);
  assert.equal((await run('say', 'Anyone want to come to tea with me?')).code, 0);
  assert.ok(existsSync(join(soul, "memory/promises.md")), JSON.stringify(seen));
  const promises = readFileSync(join(soul, "memory/promises.md"), "utf8").replace(/\\(.)/g, "$1");
  assert.match(promises, /Said I will come: Morning tea at Commons Dining Area, starts \S+ \[a:cal-1\]/);
  assert.match(promises, /I invited whoever was near: Anyone want to come to tea with me\? \[a:sp_42\]/);
});
