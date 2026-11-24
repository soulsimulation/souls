// The thin command pairs, checks and acts on a target (Engine v2 C10, #3414): `pair <world url>` against the real
// directory (`directoryd`, W2), `can <act>` answered by the daemon's local check (R8), and `act <act> [<arg id>...]`
// walking to a named thing and sitting on a chosen chair of N2's test world (`worldd gateway-link --testworld`, I4b)
// through the real gateway (`gatewayd`, I1), each ending with its receipt. Run from v2/ after
//   cargo build -p directoryd -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode } from '../brief/copy.mjs';
import { DEFAULT_PKG, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { actEnd, lookParams, requestOf, worldOf } from './souls.mjs';
import { stopThenRemove } from '../../../tools/teardown/stop.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const CLI = join(here, 'souls.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-c10-'));
const procs = [];
const daemons = [];

function run(path, args, ready) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = ready.exec(out); if (m) ok({ p, m, out: () => out }); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => fail(new Error(`${path} ended (${c}): ${out}`)));
  });
}

async function waitFor(f, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(20);
  }
}

/** The thin command, as a harness runs it. */
function souls(home, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG }, encoding: 'utf8' });
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/** The answer event that ends `sequence`, read from the daemon: a walk's or a form's accepted (kind 3, sent as its
 *  run starts, W11 #4087) is read past to its receipt or refusal; an act has at most one. */
const got = []; // every answer read, kept: one read may take the answers of several intents
async function answerOf(rt, sequence) {
  const end = await waitFor(async () => {
    got.push(...(await request(rt.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer'));
    return got.find((e) => e.sequence === sequence && e.answer !== 3);
  }, 60_000);
  assert.ok(got.filter((e) => e.sequence === sequence && e.answer === 3).length <= 1, `one accepted at most: ${sequence}`);
  return end;
}

const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

let world, gateway, named;
before(async () => {
  world = join(dir, 'w.sock');
  const w = spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--rooms', '1', '--bodies', '1', '--testworld'], { stdio: ['ignore', 'pipe', 'ignore'] });
  procs.push(w);
  let out = '';
  w.stdout.on('data', (d) => { out += d; });
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  named = Object.fromEntries(out.trim().split('\n').map((l) => l.split(' ')).filter((p) => p[0] === 'testworld').map(([, id, ...name]) => [name.join(' '), id]));
});

after(async () => {
  for (const rt of daemons) await request(rt.socket, { op: 'stop' }).catch(() => {});
  await stopThenRemove(procs, dir);
});

test('the arguments: pair takes a world url, can and act take act words; a world url names its directory and gateway', () => {
  // #3705: today's names: stop ends your act, quit the daemon; receipt, events --since and conversations.
  assert.deepEqual(requestOf(['stop']).req, { op: 'halt' });
  assert.deepEqual(requestOf(['stop', '12']).req, { op: 'halt', sequence: 12 });
  assert.equal(requestOf(['stop', 'now']).refused, 'stop-sequence');
  assert.deepEqual(requestOf(['quit']).req, { op: 'stop' });
  assert.deepEqual(requestOf(['receipt', '7']).req, { op: 'receipt', sequence: 7 });
  assert.deepEqual(requestOf(['events', '--since', '4']).req, { op: 'events', since: 4 });
  assert.equal(requestOf(['events', '--since', 'c_4']).refused, 'events-since');
  assert.deepEqual(requestOf(['conversations']).req, { op: 'converse', do: 'list' });
  assert.deepEqual(requestOf(['act', 'sit:ab-1', 'walk:ab-2']).req, { op: 'act', acts: ['sit:ab-1', 'walk:ab-2'] });
  assert.deepEqual(requestOf(['can', 'fill:ab-1', 'ab-2']).req, { op: 'can', acts: ['fill:ab-1', 'ab-2'] });
  // G3: look set takes a preset's name or a params file, and waits for the receipt.
  const set = requestOf(['look', 'set', 'punk']);
  assert.deepEqual([set.req, set.wait], [{ op: 'look-set', params: '{"preset":"punk"}' }, true]);
  assert.deepEqual(requestOf(['look']).req, { op: 'look' }, 'look alone is the brief');
  assert.equal(requestOf(['look', 'set']).refused, 'look-set-usage');
  const files = { 'mine.json': '{"frame":"fem","hair":"bob"}', 'list.json': '[1]', 'big.json': JSON.stringify({ hair: 'x'.repeat(2100) }) };
  const read = (f) => { if (!(f in files)) throw new Error('no file'); return files[f]; };
  assert.deepEqual(lookParams('mine.json', read), { params: '{"frame":"fem","hair":"bob"}' });
  assert.equal(lookParams('list.json', read).refused, 'look-params');
  assert.equal(lookParams('big.json', read).refused, 'look-params');
  assert.equal(lookParams('nowhere.json', read).refused, 'look-set-usage');
  // D1: --wait is the command's, not an act word.
  const waited = requestOf(['act', 'sit:ab-1', '--wait', '--for', 'm1']);
  assert.deepEqual([waited.req, waited.wait], [{ op: 'act', acts: ['sit:ab-1'], for: 'm1' }, true]);
  assert.equal(requestOf(['act', 'sit:ab-1']).wait, undefined);
  assert.deepEqual(requestOf(['pair', 'https://soul.game/eden']).req, { op: 'pair', url: 'https://soul.game/eden' });
  assert.deepEqual(worldOf('https://soul.game/eden'), { directory: 'https://soul.game', world: 'eden', gateway: 'wss://soul.game/v2/ws' });
  assert.deepEqual(worldOf('http://127.0.0.1:9/local?gateway=ws://127.0.0.1:8/v2/ws'), { directory: 'http://127.0.0.1:9', world: 'local', gateway: 'ws://127.0.0.1:8/v2/ws' });
  assert.throws(() => worldOf('eden'), { code: 'pair-names-a-world' });
});

test('D1: act --wait returns the final phase, the refusal, or after its window a still-running line with how to check', async () => {
  const sent = { ok: true, sequence: 7, sent: true };
  const daemon = (answers) => async (r) => ({ ok: true, receipt: { sequence: r.sequence, answers: answers() }, ...(r.quiet ? {} : { at: 'v9', changed: { n: 1 } }) });
  let polls = 0;
  const done = await actEnd(daemon(() => (++polls < 3 ? [{ answer: 'accepted' }] : [{ answer: 'accepted' }, { answer: 'receipt' }])), sent, { sleep: async () => {} });
  // D7: the seat a fallback took, named on the answer as the receipt names it.
  const held = { rank: 1, verb: 'eden:sit', id: 'ab-2', name: 'sage armchair', fallback: true };
  const seated = await actEnd(async (r) => ({ ok: true, receipt: { sequence: 7, answers: [{ answer: 'receipt' }], ...(r.quiet ? {} : { held }) } }), sent, { sleep: async () => {} });
  assert.deepEqual(seated.held, held);
  assert.deepEqual([done.ok, done.phase, done.sequence, done.at, done.changed], [true, 'done', 7, 'v9', { n: 1 }], 'what changed comes with the last answer');
  const refused = await actEnd(daemon(() => [{ answer: 'refused', reason: 'seat.taken' }]), sent, { sleep: async () => {} });
  assert.deepEqual([refused.ok, refused.phase, refused.code, refused.reason], [false, 'refused', 'seat.taken', 'seat.taken']);
  // A walk the world's ladder ended (N1's goal-unreachable, named like walk.blocked): what it waited for, from the receipt.
  const why = '12.4 m from its leg\'s end';
  const stuck = await actEnd(async (r) => ({ ok: true, receipt: { sequence: 7, answers: [{ answer: 'refused', reason: 'goal-unreachable' }], ...(r.quiet ? {} : { why }) } }), sent, { sleep: async () => {} });
  assert.deepEqual([stuck.ok, stuck.phase, stuck.code, stuck.why, stuck.try], [false, 'refused', 'goal-unreachable', why, undefined]);
  let t = 0;
  const still = await actEnd(daemon(() => [{ answer: 'accepted' }]), sent, { ms: 60_000, now: () => t, sleep: async (ms) => { t += ms; } });
  assert.deepEqual([still.ok, still.stillRunning, still.phase], [true, true, 'running']);
  assert.match(still.detail, /still running after 60 s: check with `receipt 7`/);
  const notSent = { ok: false, code: 'stopped-locally', sent: false };
  assert.equal(await actEnd(async () => assert.fail('nothing asked'), notSent), notSent, 'a local refusal is returned as it is');
});

test('A2: an act carries each candidate\'s own target, and the first one\'s thing arguments in parameter 1 (C2)', async () => {
  const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
  wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
  const [s, a, b, c] = ['07'.repeat(16), `${'07'.repeat(16)}-9004`, `${'07'.repeat(16)}-9002`, `${'0a'.repeat(16)}-3`];
  const bytes = wire.wireIntent(Buffer.from(s, 'hex'), 9001n, 'local:fill local:sit', 1n, new Uint8Array(), 10n ** 15n, `${a} ${b}`, undefined, `tap=${c}`);
  const m = decode(bytes), id = (v) => `${Buffer.from(v[0]).toString('hex')}-${v[1]}`;
  assert.equal(id(m.get(3)), a, 'the first candidate on its own target');
  const [fallback] = m.get(9);
  assert.equal(fallback.get(2), 'local:sit');
  assert.equal(id(fallback.get(3)), b, 'the fallback on its own target');
  const [[name, arg]] = m.get(4).get(1);
  assert.equal(Buffer.from(name).toString(), 'tap');
  assert.equal(id(arg), c, 'the thing argument, by name, in parameter 1');
  assert.throws(() => wire.wireIntent(Buffer.from(s, 'hex'), 9001n, 'local:fill', 1n, new Uint8Array(), 10n ** 15n, a, undefined, 'tap'), /arg-not-name-and-id/);
  // #3603: a steer's point, [x, z] µm, negative or not, as parameter 1.
  const steer = decode(wire.wireIntent(Buffer.from(s, 'hex'), 9001n, 'carrier:steer', 2n, new Uint8Array(), 10n ** 15n, a, undefined, undefined, JSON.stringify({ 1: [-59800000, 250000] })));
  assert.equal(steer.get(2), 'carrier:steer');
  assert.deepEqual(steer.get(4).get(1).map(Number), [-59800000, 250000]);
});

test('A1, A2: can answers from the local check; a walk to a named thing and a sit on a chosen chair each end with their receipt', async () => {
  // The test world's one Soul, signed in with a token the gateway knows.
  const grant = `soul-${named.soul}`, token = `${grant}.${randomBytes(32).toString('hex')}`;
  const tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `${grant} ${createHash('sha256').update(token).digest('hex')}\n`);
  const { m } = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  gateway = `ws://${m[1]}/v2/ws`;
  const home = join(dir, 'acts', '.souls'), soul = `s_${named.soul}`;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [soul]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  const rt = runtimeOf(home, soul);
  daemons.push(rt);
  souls(home, ['status']);
  await waitFor(async () => { const s = await request(rt.socket, { op: 'status' }); return s.connected && !s.syncing; });

  const chair = named['the west chair'];
  const can = souls(home, ['can', `sit:${chair}`]);
  assert.equal(can.ok, true, JSON.stringify(can));
  assert.ok(['yes', 'no', 'unknown'].includes(can.can), 'R8\'s verdict, not unknown-command');
  assert.equal(souls(home, ['can']).code, 'act-candidate');

  // #3686: inspect and object read the thing and its kind's offers from this machine; object sends one through act.
  // The test world's chairs are not in the Soul's copy (an unknown id, below); its room is.
  const room = souls(home, ['find', 'room']).found[0].id;
  const sentBefore = (await request(rt.socket, { op: 'status' })).sent;
  const bare0 = () => souls(home, ['inspect', room]);
  // #3704: several reads in one call from the copy; a write in a batch is refused, and none of it sends anything.
  const q = souls(home, ['query', JSON.stringify([{ find: 'room' }, { place: room, depth: 2 }, { kind: bare0().kind }])]);
  assert.equal(q.ok, true, JSON.stringify(q));
  assert.equal(q.answers[0].found[0].id, room);
  assert.ok(q.answers[1].inside.length > 0 && q.answers[2].found.some((r) => r.id === room), JSON.stringify(q.answers));
  // #3851: near a node, from the poses the copy holds; a near the copy cannot place is answered by name.
  const child = q.answers[1].inside[0];
  const near = souls(home, ['query', JSON.stringify([{ find: child.name, near: room, within: 1000 }, { kind: bare0().kind, near: room, within: 1000 }, { find: 'room', near: 'nowhere at all' }])]);
  assert.equal(near.ok, true, JSON.stringify(near));
  const there = near.answers[0].found?.find((r) => r.id === child.id);
  assert.ok(there && Number.isFinite(there.metres) && near.answers[0].near.id === room, JSON.stringify(near.answers[0]));
  assert.ok(!near.answers[1].found.some((r) => r.id === room), 'the anchor itself is not near itself');
  assert.equal(near.answers[2].code, 'query.unknown-near');
  const b = souls(home, ['batch', JSON.stringify([{ look: {} }, { find: 'room' }, { inspect: room }, { act: `sit:${chair}` }])]);
  assert.deepEqual(b.results.map((r) => [r.op, r.ok]), [['look', true], ['find', true], ['inspect', true], ['act', false]], JSON.stringify(b));
  assert.equal(b.results[3].code, 'batch-reads-only');
  assert.equal(b.results[2].id, room);
  const cat = souls(home, ['catalog']);
  assert.ok(cat.ok && cat.kinds.some((k) => k.kind === bare0().kind && k.count >= 1), JSON.stringify(cat));
  const ctx = souls(home, ['context', 'room']);
  assert.ok(ctx.ok && ctx.targets.some((t) => t.ref === room), JSON.stringify(ctx));
  assert.equal((await request(rt.socket, { op: 'status' })).sent, sentBefore, 'reads send nothing');
  const bare = souls(home, ['inspect', room]);
  assert.equal(bare.ok, true, JSON.stringify(bare));
  assert.deepEqual(bare.offers.map((o) => o.name), ['walk'], 'no kind entry held: the walk alone');
  mkdirSync(join(home, 'kinds'), { recursive: true });
  writeFileSync(join(home, 'kinds', 'chair.json'), JSON.stringify({ format: 'souls-entry/1', kind: bare.kind, owner: 'thing',
    slots: { seat: { admits: 'body', posture: 'sit', most: 1 } },
    forms: { tidy: { who: 'anyone', starts: 'act', takes: { pattern: { type: 'value', of: ['along'] }, grams: { type: 'count' } }, needs: [], steps: [], effects: [] } } }));
  const seen = souls(home, ['inspect', room]);
  assert.deepEqual(seen.offers.map((o) => o.name), ['walk', 'sit', 'tidy'], JSON.stringify(seen));
  assert.deepEqual(seen.offers[2].params.pattern, { type: 'value', of: ['along'] });
  assert.deepEqual(souls(home, ['object', room]).offers, seen.offers, 'object with no offer lists the same offers');
  assert.equal((await request(rt.socket, { op: 'status' })).sent, sentBefore, 'inspect and object without an offer send nothing');
  const unknownId = souls(home, ['inspect', chair]);
  assert.equal(unknownId.code, 'inspect.unknown-id', JSON.stringify(unknownId));
  assert.ok(Array.isArray(unknownId.did_you_mean) && unknownId.did_you_mean.length > 0);
  const unknownOffer = souls(home, ['object', room, 'tdy']);
  assert.equal(unknownOffer.code, 'object.unknown-offer', JSON.stringify(unknownOffer));
  assert.deepEqual(unknownOffer.did_you_mean[0], 'tidy');
  const tidy = souls(home, ['object', room, 'tidy', 'pattern=along', 'grams=5']);
  assert.equal(tidy.ok, true, JSON.stringify(tidy));
  assert.ok((await answerOf(rt, tidy.sequence)).answer >= 1, 'the form went through act and was answered');
  const walkThere = souls(home, ['object', room, 'walk']);
  assert.equal(walkThere.ok, true, JSON.stringify(walkThere));
  assert.ok((await answerOf(rt, walkThere.sequence)).answer >= 1, 'object <id> walk went through act and was answered');
  rmSync(join(home, 'kinds'), { recursive: true });

  // #3603: the engine's carrier verbs are sent as they are, never checked as forms; a point in metres goes as parameter
  // 1, [x, z] µm; the world's refusal comes back by name (the room is not a carrier, and this Soul sits in nothing).
  const halfPoint = souls(home, ['act', `carrier:steer:${room}`, 'x=4']);
  assert.equal(halfPoint.code, 'steer-needs-a-point', JSON.stringify(halfPoint));
  assert.equal(halfPoint.sent, false, 'a point half given sends nothing');
  for (const words of [[`carrier:steer:${room}`, 'x=-59.8', 'z=0.25'], [`carrier:stop:${room}`], [`carrier:land:${room}`]]) {
    const sent = souls(home, ['act', ...words]);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.dropped, undefined, 'not stopped by the local form check');
    const got = await answerOf(rt, sent.sequence);
    assert.ok(got.answer > 1 && typeof got.reason === 'string' && got.reason.length > 0, `refused by name: ${JSON.stringify(got)}`);
  }

  // R1b: an act the world refuses names one offer of the same thing that would work, from this client's own offers:
  // a form the rules pass on the copy before a move they cannot judge here, never one needing arguments, never the
  // refused verb, walking there last.
  mkdirSync(join(home, 'kinds'), { recursive: true });
  writeFileSync(join(home, 'kinds', 'chair.json'), JSON.stringify({ format: 'souls-entry/1', kind: bare.kind, owner: 'thing',
    slots: { seat: { admits: 'body', posture: 'sit', most: 1 } },
    forms: { tidy: { who: 'anyone', starts: 'act', takes: { grams: { type: 'count' } }, needs: [], steps: [], effects: [] },
      rest: { who: 'anyone', starts: 'act', needs: [], steps: [], effects: [] } } }));
  const refusedHere = souls(home, ['act', `carrier:stop:${room}`, '--wait']);
  assert.deepEqual([refusedHere.ok, refusedHere.phase], [false, 'refused'], JSON.stringify(refusedHere));
  assert.deepEqual(refusedHere.try, { act: `rest:${room}`, name: 'rest', checked: 'yes' }, JSON.stringify(refusedHere.try));
  assert.deepEqual(souls(home, ['receipt', String(refusedHere.sequence)]).receipt.try, refusedHere.try, 'the receipt names it too');
  rmSync(join(home, 'kinds'), { recursive: true });

  // #3705: `stop` ends this Soul's own walk where it stands (a souls:cancel naming it); `receipt` shows its answers,
  // `events --since` lists what came without taking it, `conversations` lists the copy's, and `quit` is the daemon's.
  const cursor = souls(home, ['events']).cursor;
  assert.equal(typeof cursor, 'number');
  const far = souls(home, ['act', named['the chair in the square']]);
  assert.equal(far.ok, true, JSON.stringify(far));
  await sleep(300);
  const stop = souls(home, ['stop']);
  assert.deepEqual([stop.ok, stop.stops], [true, far.sequence], JSON.stringify(stop));
  const stopped = await answerOf(rt, far.sequence);
  assert.deepEqual([stopped.answer, stopped.reason], [2, 'act.stopped'], `the walk ended by the stop: ${JSON.stringify(stopped)}`);
  assert.equal((await answerOf(rt, stop.sequence)).answer, 1, 'the stop has its receipt');
  const r = souls(home, ['receipt', String(far.sequence)]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.receipt.sequence, r.receipt.going, r.receipt.answers.at(-1).answer, r.receipt.answers.at(-1).reason], [far.sequence, false, 'refused', 'act.stopped']);
  assert.equal(souls(home, ['receipt']).receipt.sequence, stop.sequence, 'the newest sent, by default');
  assert.equal(souls(home, ['receipt', '999999']).code, 'receipt-not-found');
  const again = souls(home, ['stop']);
  assert.equal(again.code, 'nothing-to-stop', JSON.stringify(again));
  assert.match(again.detail, /quit/, 'a pointer to the daemon\'s new name');
  const since = souls(home, ['events', '--since', String(cursor)]);
  assert.ok(since.events.length >= 2 && since.events.every((e) => e.n > cursor), JSON.stringify(since));
  assert.ok(since.events.some((e) => e.kind === 'answer' && e.sequence === far.sequence && e.reason === 'act.stopped'));
  assert.deepEqual(souls(home, ['events', '--since', String(since.cursor)]).events, [], 'nothing after the newest');
  assert.equal(souls(home, ['events', '--since', String(cursor)]).events.length, since.events.length, 'a read takes nothing');
  const talks = souls(home, ['conversations']);
  assert.equal(talks.ok, true, JSON.stringify(talks));
  assert.deepEqual(talks.conversations, souls(home, ['converse', 'list']).conversations, 'the same as converse list');

  // 0.135 G1: a walk names its gait, sent as parameter 2 (`gait:jog`); an unknown gait is refused by name.
  const jog = souls(home, ['act', chair, 'gait=jog', '--wait']);
  assert.deepEqual([jog.ok, jog.phase], [true, 'done'], `the jog ends with a receipt: ${JSON.stringify(jog)}`);
  const sprint = souls(home, ['act', chair, 'gait=sprint', '--wait']);
  assert.deepEqual([sprint.ok, sprint.phase, sprint.reason], [false, 'refused', 'move.unknown-gait'], JSON.stringify(sprint));

  // D1: act --wait returns once the receipt has its final phase, or the world's refusal by name.
  const walk = souls(home, ['act', chair, '--wait']);
  assert.deepEqual([walk.ok, walk.phase, walk.receipt?.answers.at(-1).answer], [true, 'done', 'receipt'], `the walk ends with a receipt: ${JSON.stringify(walk)}`);
  const sit = souls(home, ['act', `sit:${chair}`, `sit:${named['the chair in the square']}`, '--wait']);
  assert.deepEqual([sit.ok, sit.phase], [true, 'done'], `the sit ends with a receipt: ${JSON.stringify(sit)}`);
  assert.equal(typeof sit.changed, 'object', 'the answer closes as any command does');
  const notCarrier = souls(home, ['act', `carrier:stop:${room}`, '--wait']);
  assert.deepEqual([notCarrier.ok, notCarrier.phase, typeof notCarrier.code], [false, 'refused', 'string'], JSON.stringify(notCarrier));
  assert.equal(notCarrier.code, notCarrier.reason);
  // A thing argument the copy cannot name is refused before anything is sent.
  assert.equal(souls(home, ['act', `fill:${chair}`, named['the chair in the square']]).code, 'act-arg-unnamed');
});

test('A1: pair <world url> prints the link and code and returns; once the owner approves, the Soul is ready to act', async () => {
  const tokensFile = join(dir, 'pair-gateway', 'tokens.txt');
  mkdirSync(dirname(tokensFile), { recursive: true });
  const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'),
    '--gateway-tokens', tokensFile], /listening on (\S+)\n/);
  const directory = `http://${m[1]}`;
  const gwPort = await freePort();
  const home = join(dir, 'paired', '.souls');
  const asked = souls(home, ['pair', `${directory}/local?gateway=ws://127.0.0.1:${gwPort}/v2/ws`]);
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.step, 'approve');
  assert.match(asked.code, /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/);
  assert.equal(asked.link, `http://127.0.0.1:1/pair?code=${asked.code}`);
  assert.ok(!existsSync(join(home, 'credentials.json')), 'nothing paired before the approval');

  // The owner approves once, signed in; the pairing left polling in the background keeps the token.
  const approve = await fetch(new URL('/v1/pair/approve', directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: asked.code, confirm: true, test_person: 'owner' }) });
  assert.equal(approve.status, 200);
  const creds = await waitFor(() => { try { return JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')); } catch { return null; } });
  const [soul] = Object.keys(creds.souls);
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);

  // Ready to act: the gateway knows the token, and an act sent through the thin command is answered.
  await run(bin('gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', world, '--tokens', tokensFile, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  const rt = runtimeOf(home, soul);
  daemons.push(rt);
  const act = souls(home, ['act', 'local:wave']);
  assert.equal(act.ok, true, JSON.stringify(act));
  const answered = await answerOf(rt, act.sequence);
  assert.ok(answered.answer >= 1, JSON.stringify(answered));
  const secret = creds.souls[soul].local.token.split('.')[1];
  assert.ok(!readFileSync(join(home, 'pairing.log'), 'utf8').includes(secret), 'the token is not in the pairing\'s log');
});
