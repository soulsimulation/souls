#!/usr/bin/env node
// V20's live check (#2764), on a local world: `worldd gateway-link --www` (the toggles world, `--souls` named bodies,
// one of them speaking every two seconds), `vite` serving its stream under /s/ and the crowd's body files from
// v2/web/.local/bodies, and a laptop and a phone (Playwright's presets, the phone with touch) at the same time:
//  - Step 0 / A5: the page lands on broadcast; with no input for `--broadcast` s, every 250 ms: the subject, whether a
//    drawn body is in frame, and the director's own time a frame (a camera tracking one body, the crowd on);
//  - A4: a Soul's name typed in the find box and Enter, the flight's time to that Soul;
//  - A1 (no door here: the door is camera.test.ts): the followed Soul in frame for 5 s after the flight;
//  - A3: the address while following, opened in a new page, opens on that Soul;
//  - A2: on the phone, one finger, a pinch and two fingers (CDP touch events), and on the laptop a drag, the wheel and
//    a right-drag, each moving the camera.
//
//   node v2/web/src/camera/measure.mjs [--souls 200] [--broadcast 600] [--port 5183] [--out dir]
// Needs v2/target/debug/worldd and the WASM replica (v2/tools/ci.sh's wasm steps), and the body files in
// v2/web/.local/bodies (see crowd/bench.mjs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const WEB = resolve(import.meta.dirname, '../..');
const V2 = resolve(WEB, '..');
const REPO = resolve(V2, '..');
const imp = (p) => import(pathToFileURL(join(REPO, p)).href);
const o = { souls: 200, broadcast: 600, port: 5183, out: join(REPO, '.local/v20') };
for (let i = 2; i < process.argv.length; i += 2) o[process.argv[i].slice(2)] = isNaN(Number(process.argv[i + 1])) ? process.argv[i + 1] : Number(process.argv[i + 1]);
const log = (s) => console.log(`[v20 ${new Date().toISOString().slice(11, 19)}] ${s}`);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : null; };
const r2 = (x) => (x == null ? null : +x.toFixed(2));
const SYL = ['or', 'iel', 'ma', 'ren', 'tho', 'lin', 'ka', 'vi', 'sol', 'da', 'mir', 'en', 'ul', 'bri', 'na', 'ces'];
const nameOf = (i) => { const n = SYL[i % 16] + SYL[(i >> 4) % 16] + (i >= 256 ? SYL[(i >> 8) % 16] : ''); return n[0].toUpperCase() + n.slice(1); };

async function world(work) {
  const pkg = join(V2, 'target/wasm-load/pkg'), worldd = join(V2, 'target/debug/worldd');
  for (const f of [join(pkg, 'replica.js'), worldd]) if (!existsSync(f)) throw new Error(`${f}: build it first`);
  const replica = await import(pathToFileURL(join(pkg, 'replica.js')).href);
  replica.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
  const { decode, encode } = await import(pathToFileURL(join(WEB, 'node_modules/cborg/cborg.js')).href);
  const www = join(work, 'www'), sock = join(work, 'w.sock');
  const proc = spawn(worldd, ['gateway-link', '--socket', sock, '--lineage', 'ce'.repeat(16), '--epoch', '1', '--log', join(work, 'log'), '--rooms', '1', '--bodies', String(o.souls), '--no-measures', '--watchdog-ms', '5000', '--www', www], { stdio: ['ignore', 'pipe', 'inherit'] });
  const bodies = [];
  const stream = await new Promise((ok, no) => {
    proc.once('exit', (c) => no(new Error(`worldd exited ${c}`)));
    createInterface({ input: proc.stdout }).on('line', (l) => (l.startsWith('body ') ? bodies.push(l.slice(5)) : l.startsWith('stream ') && ok(l.slice(7))));
  });
  while (!existsSync(sock)) await new Promise((r) => setTimeout(r, 20));
  const conn = createConnection(sock);
  await new Promise((r) => conn.once('connect', r));
  conn.on('data', () => {});
  const seqs = new Map();
  const send = (body, verb, params) => {
    const [scope, counter] = body.split('-');
    const seq = (seqs.get(body) ?? 0) + 1;
    seqs.set(body, seq);
    const intent = decode(replica.wireIntent(Buffer.from(scope, 'hex'), BigInt(counter), verb, BigInt(seq), new Uint8Array(), BigInt((Date.now() + 60_000) * 1000), ''), { useMaps: true });
    intent.set(4, params);
    const out = encode(intent), len = Buffer.alloc(4);
    len.writeUInt32BE(out.length);
    conn.write(Buffer.concat([len, out]));
  };
  const words = (w) => new Map([[23, new TextEncoder().encode(w)]]);
  bodies.forEach((b, i) => send(b, 'eden:describe', new Map([[1, words(nameOf(i))], [2, words(`one of ${o.souls}`)]])));
  let k = 0;
  const talk = setInterval(() => send(bodies[(++k * 37) % bodies.length], 'eden:say', new Map([[1, words(`line ${k}`)]])), 2000);
  return { stream: stream.replace(/\/?$/, '/'), www, stop: () => (clearInterval(talk), conn.destroy(), proc.kill('SIGKILL')) };
}

async function vite(www) {
  const p = spawn(process.execPath, [join(WEB, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(o.port), '--strictPort'], { cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, V2_STREAM_DIR: www } });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${o.port}/`)).ok) return p; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  p.kill();
  throw new Error('vite did not start');
}

// In the page: the director's time a frame, and every 250 ms whether any drawn body is in frame and who is followed.
const PROBE = () => {
  const V = window.v2, D = V.director, P = (window.__v20 = { cost: [], samples: [] });
  const update = D.update.bind(D);
  D.update = (dt, t) => { const s = performance.now(); update(dt, t); P.cost.push(performance.now() - s); };
  const C = V.cam.camera.constructor, v = new V.cam.camera.position.constructor();
  P.timer = setInterval(() => {
    const cam = V.cam.camera, t = D.t;
    let inFrame = 0;
    if (t !== null) for (const id of V.souls.copy.souls.keys()) {
      const n = V.world.nodes.get(id), p = V.world.tracks.get(id)?.at(t);
      if (!n) continue;
      if (p) v.set(p[0] * 1e-6, p[1] * 1e-6, p[2] * 1e-6).applyMatrix4(V.world.frame(n.parent));
      else v.setFromMatrixPosition(V.world.frame(id));
      v.y += 1;
      v.project(cam);
      if (Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z > -1 && v.z < 1) inFrame++;
    }
    P.samples.push({ at: performance.now(), mode: D.mode, subject: D.follow?.id ?? null, inFrame });
  }, 250);
  void C;
};

// A wall across x = x0 (0.2 m thick, 20 m long, 3 m high) with a 1.2 m doorway and a 0.8 m lintel, 40 m off the
// stream's line of Souls, and a Soul walking through the doorway from 8 m before it to 8 m past it, starting 2 s on.
const DOOR = () => {
  const V = window.v2, t0 = V.director.t + 2e6, x0 = 0, z0 = 40, S = 1e6, ID = 'v20.walker';
  const node = (id, kind, o) => ({ id, kind, parent: null, slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, ...o });
  const wall = node('v20.wall', 'test:wall', { pos: [x0 * S, 0, z0 * S], solids: [[0, -5600, 100, 5000, 0, 0, 3000, 1], [0, 5600, 100, 5000, 0, 0, 3000, 1], [0, 0, 100, 600, 0, 2200, 3000, 1]] });
  const samples = [];
  for (let s = 0; s <= 16; s++) samples.push([ID, 'v20.g', null, t0 + s * S, (x0 + s - 8) * S, 0, z0 * S]);
  // The walker stands at its start until it sets off.
  samples.unshift([ID, 'v20.g', null, t0 - 30 * S, (x0 - 8) * S, 0, z0 * S]);
  const nodes = [node('v20.g', 'eden:ground'), wall, node(ID, 'souls:body', { parent: 'v20.g', at: t0 + 16 * S, pos: [(x0 + 8) * S, 0, z0 * S], name: 'Walker', description: 'walks through a door' })];
  V.world.apply(nodes, [], samples);
  V.things.apply?.(nodes, []);
  V.souls.copy.apply({ nodes, removed: [], said: [], to: V.director.t });
  return { t0, x0, z0 };
};
const WALK = async ({ t0, x0, z0 }) => {
  const V = window.v2, D = V.director, out = [];
  while (D.t < t0 + 17e6) {
    await new Promise((r) => setTimeout(r, 100));
    const eye = V.cam.camera.position, tg = V.cam.controls.target, t = D.t;
    // The walker's target (feet + 1 m) in the view; the eye inside the wall; the sightline through the wall, not the door.
    const v = tg.clone().project(V.cam.camera), inFrame = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z > -1 && v.z < 1;
    const inWall = Math.abs(eye.x - x0) < 0.1 && eye.y < 3 && Math.abs(eye.z - z0) < 10.6 && !(Math.abs(eye.z - z0) < 0.6 && eye.y < 2.2);
    let cut = false;
    if ((eye.x - x0) * (tg.x - x0) < 0) {
      const f = (x0 - tg.x) / (eye.x - tg.x), y = tg.y + (eye.y - tg.y) * f, z = tg.z + (eye.z - tg.z) * f - z0;
      cut = y < 3 && Math.abs(z) < 10.6 && !(Math.abs(z) < 0.6 && y < 2.2);
    }
    out.push({ walkerX: +(tg.x - x0).toFixed(2), following: D.mode === 'follow' && D.follow?.id === 'v20.walker', inFrame, inWall, cut, eyeM: +eye.distanceTo(tg).toFixed(2), passed: t > t0 + 8e6 });
  }
  const c = window.__v20.cost.slice().sort((a, b) => a - b), q = (p) => +c[Math.min(c.length - 1, Math.ceil(c.length * p) - 1)].toFixed(3);
  return {
    samples: out.length, following: out.filter((s) => s.following).length, inFrame: out.filter((s) => s.inFrame).length,
    eyeInWall: out.filter((s) => s.inWall).length, wallHidesSoul: out.filter((s) => s.cut).length, wentThrough: out.some((s) => s.walkerX < -1) && out.some((s) => s.walkerX > 1),
    nearestEyeM: Math.min(...out.map((s) => s.eyeM)), bodiesDrawn: V.world.tracks.size, directorMs: { median: q(0.5), p95: q(0.95), max: q(1) },
  };
};

const gapS = (samples, ok) => {
  let worst = 0, from = null;
  for (const s of samples) {
    if (ok(s)) from = null;
    else (from ??= s.at), (worst = Math.max(worst, (s.at - from) / 1000));
  }
  return r2(worst);
};

async function camPose(page) {
  return page.evaluate(() => { const c = window.v2.cam; return { eye: c.camera.position.toArray(), target: c.controls.target.toArray(), mode: window.v2.director.mode }; });
}
const moved = (a, b) => r2(Math.hypot(...a.eye.map((x, i) => x - b.eye[i])));

async function gestures(page, tier) {
  const out = {};
  const W = tier === 'phone' ? 390 : 1280, H = tier === 'phone' ? 844 : 720, cx = W / 2, cy = H / 2;
  if (tier === 'phone') {
    const cdp = await page.context().newCDPSession(page);
    const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const drag = async (from, to, steps = 12) => {
      await touch('touchStart', from);
      for (let s = 1; s <= steps; s++) {
        await touch('touchMove', from.map(([x, y], i) => [x + ((to[i][0] - x) * s) / steps, y + ((to[i][1] - y) * s) / steps]));
        await page.waitForTimeout(16);
      }
      await touch('touchEnd', []);
      await page.waitForTimeout(400);
    };
    for (const [name, from, to] of [
      ['one finger', [[cx - 60, cy]], [[cx + 60, cy]]],
      ['pinch', [[cx - 30, cy], [cx + 30, cy]], [[cx - 120, cy], [cx + 120, cy]]],
      ['two fingers', [[cx - 40, cy], [cx + 40, cy]], [[cx - 40, cy + 120], [cx + 40, cy + 120]]],
    ]) {
      const a = await camPose(page);
      await drag(from, to);
      const b = await camPose(page);
      out[name] = { movedM: moved(a, b), before: a.mode, after: b.mode };
    }
  } else {
    const m = page.mouse;
    for (const [name, act] of [
      ['drag', async () => { await m.move(cx - 60, cy); await m.down(); await m.move(cx + 60, cy, { steps: 12 }); await m.up(); }],
      ['wheel', async () => { await m.move(cx, cy); await m.wheel(0, 400); }],
      ['right-drag', async () => { await m.move(cx, cy - 40); await m.down({ button: 'right' }); await m.move(cx, cy + 80, { steps: 12 }); await m.up({ button: 'right' }); }],
    ]) {
      const a = await camPose(page);
      await act();
      await page.waitForTimeout(400);
      const b = await camPose(page);
      out[name] = { movedM: moved(a, b), before: a.mode, after: b.mode };
    }
  }
  return out;
}

async function arm({ browser, url, tier, VIEWPORTS }) {
  const ctx = await browser.newContext({ ...VIEWPORTS[tier] });
  try {
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => window.v2?.director?.t != null && [...window.v2.souls.copy.souls.values()].filter((s) => s.name).length >= n, o.souls, { timeout: 120_000, polling: 500 });
    await page.evaluate(PROBE);
    const landed = await page.evaluate(() => window.v2.director.mode);
    const load = loadavg()[0];
    // Step 0 and A5: broadcast with no input.
    await page.waitForTimeout(o.broadcast * 1000);
    const b = await page.evaluate(() => { const P = window.__v20; const r = { samples: P.samples, cost: P.cost, cuts: window.v2.director.broadcast.cuts }; P.samples = []; P.cost = []; return r; });
    const broadcast = {
      landed, seconds: o.broadcast, cuts: b.cuts, subjects: new Set(b.samples.map((s) => s.subject).filter(Boolean)).size,
      modes: [...new Set(b.samples.map((s) => s.mode))], worstGapS: gapS(b.samples, (s) => s.inFrame > 0), samples: b.samples.length,
      directorMs: { median: r2(q(b.cost, 0.5)), p95: r2(q(b.cost, 0.95)), max: r2(Math.max(...b.cost)) }, load: r2(load),
    };
    // A4: type a name and Enter, as a person would.
    const name = await page.evaluate(() => [...window.v2.souls.copy.souls.values()].find((s) => s.name)?.name);
    await page.locator('input[type=search]').fill(name);
    await page.locator('input[type=search]').press('Enter');
    await page.waitForFunction(() => window.v2.director.flown?.done != null, null, { timeout: 10_000 }).catch(async () => {
      const d = await page.evaluate(() => { const D = window.v2.director; return { mode: D.mode, flown: D.flown, find: D.find.placeholder, t: D.t, tracks: window.v2.world.tracks.size }; });
      throw new Error(`no flight to ${name}: ${JSON.stringify(d)}`);
    });
    const flown = await page.evaluate(() => { const f = window.v2.director.flown; return { id: f.id, seconds: f.seconds, tookS: (f.done - f.asked) / 1000, mode: window.v2.director.mode }; });
    // A1: the followed Soul in frame for 5 s.
    await page.evaluate(() => (window.__v20.samples = []));
    await page.waitForTimeout(5000);
    const f = await page.evaluate(() => window.__v20.samples);
    const follow = { samples: f.length, following: f.filter((s) => s.mode === 'follow' && s.subject).length, worstGapS: gapS(f, (s) => s.inFrame > 0) };
    // A3: the address is a link to the follow.
    const href = page.url();
    const p2 = await ctx.newPage();
    const asked = Date.now();
    await p2.goto(href, { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction((id) => window.v2?.director?.mode === 'follow' && window.v2.director.follow?.id === id, flown.id, { timeout: 60_000, polling: 100 });
    const link = { hasFollow: new URL(href).searchParams.get('follow') === flown.id, openedOn: flown.id, openedS: r2((Date.now() - asked) / 1000) };
    await p2.close();
    // A2: gestures, from following.
    const gesture = await gestures(page, tier);
    // A1 through a door, and Step 0 with a body the crowd draws: the stream's bodies never move, so the page is handed
    // (through its own `world.apply`, as a part would) a wall with a 1.2 m doorway and a Soul walking through it at
    // 1 m/s, typed into the find box, then followed; every 100 ms the eye and the sightline are checked against the wall.
    const door = await page.evaluate(DOOR);
    await page.locator('input[type=search]').fill('Walker');
    await page.locator('input[type=search]').press('Enter');
    await page.waitForFunction(() => window.v2.director.mode === 'follow' && window.v2.director.follow?.id === 'v20.walker', null, { timeout: 10_000 });
    await page.evaluate(() => (window.__v20.cost = []));
    const walking = page.evaluate(WALK, door);
    mkdirSync(o.out, { recursive: true });
    for (const [at, name] of [[8, 'before'], [10, 'in-door'], [13, 'past']]) await page.waitForFunction((x) => window.v2.director.t >= x, door.t0 + (at - 2) * 1e6, { polling: 50 }).then(() => page.screenshot({ path: join(o.out, `door-${tier}-${name}.png`) }));
    const walk = await walking;
    await page.evaluate(() => clearInterval(window.__v20.timer));
    return { tier, broadcast, flown: { ...flown, tookS: r2(flown.tookS) }, follow, link, gesture, door: walk, errors };
  } finally {
    await ctx.close();
  }
}

const work = mkdtempSync(join(tmpdir(), 'v2-v20-'));
const w = await world(work);
const server = await vite(w.www);
const url = `http://127.0.0.1:${o.port}/?stream=/s/${w.stream}&bodies=/.local/bodies/`;
try {
  const { resolvePlaywright, browsersPath, launchArgs } = await imp('tools/playtest/lib/platform.mjs');
  const { VIEWPORTS } = await imp('tools/proof/clip-presets.mjs');
  browsersPath();
  const pw = resolvePlaywright();
  const browser = await pw.chromium.launch({ headless: true, args: launchArgs().args });
  const probe = await browser.newPage();
  const gl = await probe.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2'); return g.getParameter(g.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL); });
  // A first load lets vite finish optimising the page's modules (it reloads the page once); the arms then start clean.
  await probe.goto(url, { waitUntil: 'domcontentloaded' });
  await probe.waitForFunction(() => window.v2?.director?.t != null, null, { timeout: 120_000, polling: 500 });
  await probe.waitForTimeout(3000);
  await probe.close();
  log(`renderer ${gl}; ${o.broadcast} s of broadcast on the laptop and the phone at once`);
  const rows = await Promise.all(['desktop', 'phone'].map((tier) => arm({ browser, url, tier, VIEWPORTS }).catch((e) => ({ tier, error: String(e?.message ?? e).slice(0, 300) }))));
  for (const r of rows) log(JSON.stringify(r, (k, v) => (k === 'samples' && Array.isArray(v) ? v.length : v)));
  await browser.close();
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, 'measure.json'), JSON.stringify({ souls: o.souls, gl, rows }, null, 1));
  log(`wrote ${join(o.out, 'measure.json')}`);
} finally {
  server.kill();
  w.stop();
  rmSync(work, { recursive: true, force: true });
}
