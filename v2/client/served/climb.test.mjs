// Racks V: a Soul climbs a built bay's frame by the name its own copy gives the place. N2's test world with worldd's
// deck test bay (`sim/src/structure/fixtures`: the bay, its two frames, its four beams) at the site, served by worldd,
// gatewayd and directoryd; five Souls paired and joined through the gateway. Four build the frames and the four
// beams with the thin command's `carry` and `part` steps; the fifth reads `object <frame>`: with no deck built on the
// frame there is nothing to stand on at its ladders' tops, so it offers no climb, and `object <frame> climb` is refused
// `climb.nothing-to-stand-on` (N14). Run from
// v2/ after `cargo build -p directoryd -p gatewayd -p worldd -p testworld --locked`, and replica's wasm-bindgen package
// in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { request } from '../src/daemon/client.mjs';
import { runtimeOf } from '../src/home/home.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const content = resolve(v2, '../content/kinds'), fixtures = join(v2, 'crates/sim/src/structure/fixtures');
const scratch = process.env.CLIMB_SCRATCH ?? resolve(v2, '../.local/served-climb');
mkdirSync(scratch, { recursive: true });
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
const hash = (b) => createHash('sha256').update(b).digest('hex');
const bin = (name) => process.env[name.toUpperCase()] ?? join(v2, 'target/debug', name);
const pkg = process.env.SOULS_REPLICA_PKG ?? join(v2, 'target/wasm-load/pkg');
const CLI = join(v2, 'client/src/cli/souls.mjs'), DAEMON = join(v2, 'client/src/daemon/daemon.mjs');
// testworld's site (`testworld::SITE_X`, `YARD_Z`), mm.
const SITE_X = 65_000, YARD_Z = -24_000;

/** N2's facts with the deck bay at the site, as worldd's deck test (`Bay`) lays it: the bay with its slots, its two
 *  frames standing loose on their slots' places, its 0.5 m beams lying 0.5 m outside their columns, the 1.8 m ones 1 m. */
function bayFacts(text) {
  const f = JSON.parse(text), bay = JSON.parse(readFileSync(join(fixtures, 'test_deck_bay.json'), 'utf8'));
  const refs = [['testworld-test-deck-bay@1', 'mars:test_deck_bay'], ['testworld-test-deck-frame@1', 'mars:test_deck_frame'], ['testworld-test-deck-beam@1', 'mars:test_deck_beam']];
  for (const [ref, name] of refs) f.kinds.push({ ref, hash: hash(`souls/testworld/${ref}`), name, form: 'point' });
  const slots = Object.values(bay.slots).map((s, k) => ({ n: k + 1, at: s.at_mm, yaw: 0, capacity: 1 }));
  const thing = (id, r, [x, z]) => ({ id, def: refs[r][0], ref: refs[r][0], parent: null, pose: [SITE_X + x, 0, YARD_Z + z, 0], scale_ppm: 1_000_000, name: id });
  f.things.push({ ...thing('bay', 0, [0, 0]), slots },
    thing('frame-1', 1, [0, -1_448]), thing('frame-2', 1, [0, 1_448]),
    thing('beam-low-l', 2, [-1_072, 0]), thing('beam-low-r', 2, [1_072, 0]), thing('beam-high-l', 2, [-1_572, 0]), thing('beam-high-r', 2, [1_572, 0]));
  return JSON.stringify(f);
}

test('served: a bay framed with no deck: object <frame> offers no climb, and a climb is refused, nothing to stand on', { timeout: 600_000 }, async (t) => {
  const base = mkdtempSync(join(scratch, 'run-')), children = [], home = join(base, 'home');
  mkdirSync(home, { mode: 0o700 });
  const run = (path, args, ready = null, env = {}) => new Promise((ok, fail) => {
    const p = spawn(path, args, { cwd: base, env: { ...process.env, ...env, BRAIN_MODE: 'fake' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(p);
    let text = '';
    const take = (b) => { text += b; writeFileSync(join(base, `child-${children.indexOf(p)}.log`), b, { flag: 'a' }); const m = ready instanceof RegExp ? ready.exec(text) : null; if (m) ok({ p, m }); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.once('exit', (code) => (ready ? fail(Error(`${path} ended (${code}): ${text.slice(-2000)}`)) : code === 0 ? ok({ p, text }) : fail(Error(`${path} ${args[0]} failed (${code}): ${text.slice(-2000)}`))));
    if (ready === true) ok({ p });
  });
  const souls = [];
  t.after(async () => {
    await Promise.allSettled(souls.map((s) => request(s.rt.socket, { op: 'stop' }, 2000)));
    for (const p of children) if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
  });
  const until = async (f, ms = 30_000, what = 'a phase') => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw Error(`${what} timed out`); await pause(100); } };
  const cli = async (s, ...args) => JSON.parse((await run(process.execPath, [CLI, ...args, '--soul', s.soul], null, { SOULS_HOME: home, SOULS_REPLICA_PKG: pkg })).text.trim().split('\n').at(-1));
  const post = async (origin, path, body) => { const r = await fetch(new URL(path, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  // The world: N2's facts, the bay's kinds and the body's as its entries.
  await run(bin('testworld'), ['--seed', '1', '--things', '0', '--out', base]);
  const facts = join(base, 'bay.facts.json'), entries = join(base, 'entries');
  writeFileSync(facts, bayFacts(readFileSync(join(base, 'testworld-s1-t0.facts.json'), 'utf8')));
  mkdirSync(entries);
  for (const d of [join(content, 'construction'), fixtures]) for (const f of readdirSync(d).filter((n) => n.endsWith('.json'))) copyFileSync(join(d, f), join(entries, f));
  copyFileSync(join(content, 'body/humanoid.json'), join(entries, 'humanoid.json'));
  await run(bin('worldd'), ['seed', '--facts', facts, '--dir', 'world', '--souls', '0', '--at', `${(SITE_X - 4_000) / 1000},${(YARD_Z - 5_000) / 1000}`, '--entries', entries]);
  await run(bin('worldd'), ['serve', '--dir', 'world'], /listening /);
  const gw = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', 'world/gateway.sock', '--tokens', 'world/tokens', '--entries', 'world/entries', '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  const dir = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1', '--store', join(base, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(base, 'pairing.sqlite'), '--gateway-tokens', join(base, 'world/tokens')], /listening on (\S+)\n/);
  const origin = `http://${dir.m[1]}`, gateway = `ws://${gw.m[1]}/v2/ws`;

  // Five Souls, paired and joined.
  for (const soul of ['s_climb_a', 's_climb_b', 's_climb_c', 's_climb_d', 's_climb_e']) {
    const secret = randomBytes(32).toString('hex');
    const asked = await post(origin, '/v1/pair/request', { secret_hash: hash(secret), device: 'climb fixture', label: 'served climb', scope: 'soul', new: true, world: 'local' });
    assert.equal(asked.status, 200);
    assert.equal((await post(origin, '/v1/pair/approve', { code: asked.body.code, confirm: true, test_person: 'Climb owner' })).status, 200);
    souls.push({ soul, secret, interval: asked.body.interval });
  }
  await pause(Math.max(...souls.map((s) => s.interval)) * 1000);
  for (const s of souls) { const p = await post(origin, '/v1/pair/poll', { secret: s.secret }); assert.equal(p.status, 200); s.token = p.body.token; delete s.secret; }
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { gateway, directory: origin } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: Object.fromEntries(souls.map((s) => [s.soul, { local: { token: s.token } }])) }), { mode: 0o600 });
  for (const s of souls) {
    s.rt = runtimeOf(home, s.soul);
    mkdirSync(s.rt.dir, { recursive: true });
    await run(process.execPath, [DAEMON, '--home', home, '--soul', s.soul, '--pkg', pkg], true);
    await until(async () => { try { return (await request(s.rt.socket, { op: 'status' })).connected; } catch { return false; } }, 30_000, 'daemon connects');
    assert.equal((await cli(s, 'act', 'life:join')).ok, true);
    s.body = await until(async () => { const st = await request(s.rt.socket, { op: 'status' }); return st.connected && !st.syncing && st.unanswered?.length === 0 && st.body; }, 60_000, 'join');
  }
  const [a, b, c, d, e] = souls;

  // Ids from the first Soul's copy.
  // A thing's public name reaches the copy in the background after a find asks for it.
  const idOf = async (s, name) => until(async () => (await cli(s, 'find', name)).found?.find((f) => f.name === name)?.id, 30_000, `find ${name}`);
  const ids = {};
  for (const n of ['bay', 'frame-1', 'frame-2', 'beam-low-l', 'beam-low-r', 'beam-high-l', 'beam-high-r']) ids[n] = await idOf(a, n);
  const ground = (await cli(a, 'query', JSON.stringify([{ kind: 'eden:ground', limit: 1 }]))).answers[0].found[0].id;
  const receipt = async (s, sequence) => until(async () => { const r = await request(s.rt.socket, { op: 'receipt', sequence }); const last = r?.receipt?.answers?.at(-1); return last && last.answer !== 'accepted' ? last : null; }, 120_000, `receipt ${sequence}`);
  const walk = async (pairs) => {
    const sent = await Promise.all(pairs.map(async ([s, [dx, dz]]) => [s, await request(s.rt.socket, { op: 'act', verb: 'eden:walk', target: ground, params: { 1: [(SITE_X + dx) * 1000, 0, (YARD_Z + dz) * 1000] } })]));
    for (const [s, w] of sent) assert.equal((await receipt(s, w.sequence)).answer, 'receipt', `${s.soul} walks`);
  };
  const ok = (got, what) => { assert.equal(got.ok, true, `${what}: ${JSON.stringify(got)}`); return got; };
  const crew = async (front, ...others) => {
    const offered = ok(await cli(front, 'carry', 'offer', ...others.map((o) => o.body)), 'crew offered');
    for (const o of others) ok(await cli(o, 'carry', 'accept', offered.crew), 'crew accepted');
    return offered.crew;
  };

  // The frames: each taken by two and put in its slot, one staying to hold it (worldd's deck test, `Bay::frame`).
  const holds = [];
  for (const [frame, dz, holder, slot] of [['frame-1', -1_448, b, 'upright_a'], ['frame-2', 1_448, c, 'upright_b']]) {
    await walk([[a, [1_060, dz]], [holder, [-1_060, dz]]]);
    const hold = await crew(a, holder);
    ok(await cli(a, 'part', 'take', hold, ids[frame]), `${frame} taken`);
    ok(await cli(a, 'part', 'put', hold, ids.bay, slot), `${frame} in ${slot}`);
    ok(await cli(a, 'carry', 'leave', hold), 'the front lets go');
    holds.push([holder, hold]);
  }
  // The beams: Souls a and d at a beam's ends, a 1.8 m one carried in to 0.5 m outside its slot, each put joining both frames.
  let beams = null;
  for (const [beam, from, to, slot] of [['beam-low-l', -1_072, -1_072, 'beam_low_l'], ['beam-low-r', 1_072, 1_072, 'beam_low_r'],
    ['beam-high-l', -1_572, -1_072, 'beam_high_l'], ['beam-high-r', 1_572, 1_072, 'beam_high_r']]) {
    await walk([[a, [from, -1_547]], [d, [from, 1_547]]]);
    beams ??= await crew(a, d);
    ok(await cli(a, 'part', 'take', beams, ids[beam]), `${beam} taken`);
    if (to !== from) await walk([[a, [to, -1_547]], [d, [to, 1_547]]]);
    ok(await cli(a, 'part', 'put', beams, ids.bay, slot), `${beam} in ${slot}`);
  }
  for (const [holder, hold] of holds) ok(await cli(holder, 'carry', 'leave', hold), 'a holder lets go');
  ok(await cli(a, 'carry', 'leave', beams), 'a leaves the beam crew');
  ok(await cli(d, 'carry', 'leave', beams), 'd leaves the beam crew');

  // The fifth Soul, outside frame 1, reads the frame: with no deck built on it there is nothing to stand on at its
  // ladders' tops (N14: a frame holds no standing place of its own), so it offers no climb, and one asked is refused by
  // name, the body staying on the ground.
  await walk([[e, [0, -3_900]]]);
  const seen = ok(await cli(e, 'object', ids['frame-1']), 'object frame-1');
  writeFileSync(join(base, 'object-frame-1.json'), JSON.stringify(seen, null, 2));
  console.log(`object frame-1: ${JSON.stringify({ places: seen.places, ways_up: seen.ways_up, offers: seen.offers.map((o) => o.name) })}`);
  assert.ok(!seen.offers.some((o) => o.name.startsWith('climb to ')), `no climb offer among ${JSON.stringify(seen.offers.map((o) => o.name))}`);
  assert.equal(seen.places, undefined, 'no place on the frame');
  const refused = await cli(e, 'object', ids['frame-1'], 'climb');
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'climb.nothing-to-stand-on', JSON.stringify(refused));
  const looked = await cli(e, 'look');
  assert.ok(!/standing place/.test(JSON.stringify(looked.room ?? {})), 'still on the ground');
});
