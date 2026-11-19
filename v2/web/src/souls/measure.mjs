#!/usr/bin/env node
// W4's measurement (#2748), on a local world: 1,000 Souls live (`worldd gateway-link --www`, the toggles world with
// `--bodies 1000`), each named and described, a few saying something every second, one sentence holding markup and an
// address, and one whisper. The page (`vite` serving the stream under /s/) plays it with chips, status and speech on and
// a Soul's page opened by a click on a chip. It reports:
//  - A1: every request the page made in the measured window, by class: the stream's pointer, parts and text files, and
//    anything else (must be 0);
//  - A2: frame times (median, 95th) against V6's bar (16.7 ms desktop, 33.3 ms phone; the 95th at most double), with
//    the GL renderer and the machine's load;
//  - A4: a scan of every response the page fetched for the whispered words (must be 0 hits).
// `--hold <s>` keeps the world, its talkers and the page server up that long after printing the page's URL, for the
// proof clip (no browser of its own).
//
//   node v2/web/src/souls/measure.mjs [--tiers desktop,phone] [--repeats 2] [--warm 8] [--measure 30] [--souls 1000]
//        [--port 5181] [--out dir] [--hold 0]
// Needs v2/target/debug/worldd (cargo build -p worldd) and the WASM replica (v2/tools/ci.sh's wasm steps).
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
const o = { tiers: 'desktop,phone', repeats: 2, warm: 8, measure: 30, souls: 1000, port: 5181, out: join(REPO, '.local/w4'), hold: 0 };
for (let i = 2; i < process.argv.length; i += 2) o[process.argv[i].slice(2)] = isNaN(Number(process.argv[i + 1])) ? process.argv[i + 1] : Number(process.argv[i + 1]);
const log = (s) => console.log(`[w4 ${new Date().toISOString().slice(11, 19)}] ${s}`);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : null; };
const r1 = (x) => (x == null ? null : +x.toFixed(1));

const SECRET = 'the spare key is under the third stone';
const HOSTILE = '<a href="https://example.com/x">look</a> <b>here</b> www.example.com';
const LINES = ['the bread is still warm', 'has anyone seen the ferry?', 'good morning', 'the lamps want oil again', 'I will be at the well', HOSTILE, 'rain by evening, I think', 'who left the gate open?'];
const SYL = ['or', 'iel', 'ma', 'ren', 'tho', 'lin', 'ka', 'vi', 'sol', 'da', 'mir', 'en', 'ul', 'bri', 'na', 'ces'];
const nameOf = (i) => { const n = SYL[i % 16] + SYL[(i >> 4) % 16] + (i >= 256 ? SYL[(i >> 8) % 16] : ''); return n[0].toUpperCase() + n.slice(1); };

// The world and its talkers.
async function world(work) {
  const pkg = join(V2, 'target/wasm-load/pkg'), worldd = join(V2, 'target/debug/worldd');
  for (const f of [join(pkg, 'replica.js'), worldd]) if (!existsSync(f)) throw new Error(`${f}: build it first (cargo build -p worldd; v2/tools/ci.sh's wasm steps)`);
  const replica = await import(pathToFileURL(join(pkg, 'replica.js')).href);
  replica.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
  const { decode, encode } = await import(pathToFileURL(join(WEB, 'node_modules/cborg/cborg.js')).href);
  const www = join(work, 'www'), sock = join(work, 'w.sock');
  const proc = spawn(worldd, ['gateway-link', '--socket', sock, '--lineage', 'cd'.repeat(16), '--epoch', '1', '--log', join(work, 'log'), '--rooms', '1', '--bodies', String(o.souls), '--no-measures', '--www', www], { stdio: ['ignore', 'pipe', 'inherit'] });
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
  const send = (body, verb, target, params) => {
    const [scope, counter] = body.split('-');
    const seq = (seqs.get(body) ?? 0) + 1;
    seqs.set(body, seq);
    const intent = decode(replica.wireIntent(Buffer.from(scope, 'hex'), BigInt(counter), verb, BigInt(seq), new Uint8Array(), BigInt((Date.now() + 60_000) * 1000), target), { useMaps: true });
    intent.set(4, params);
    const out = encode(intent), len = Buffer.alloc(4);
    len.writeUInt32BE(out.length);
    conn.write(Buffer.concat([len, out]));
  };
  const words = (w) => new Map([[23, new TextEncoder().encode(w)]]);
  bodies.forEach((b, i) => send(b, 'eden:describe', '', new Map([[1, words(nameOf(i))], [2, words(`one of ${o.souls}; keeps watch on stretch ${Math.floor(i / 50) + 1}`)]])));
  let k = 0;
  // Four sentences a second, from Souls across the line; the first ten Souls (nearest the start) talk most.
  const talk = setInterval(() => {
    k++;
    const who = k % 3 === 0 ? bodies[k % 10] : bodies[(k * 37) % bodies.length];
    send(who, 'eden:say', '', new Map([[1, words(LINES[k % LINES.length])]]));
    if (k % 20 === 5) send(bodies[1], 'eden:whisper', bodies[2], new Map([[1, words(SECRET)]]));
  }, 250);
  return { proc, stream: stream.replace(/\/?$/, '/'), www, bodies, stop: () => (clearInterval(talk), conn.destroy(), proc.kill('SIGKILL')) };
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

const INIT = `(() => {
  const P = window.__w4 = { frames: [], on: false };
  const tick = (t) => { if (P.on) P.frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();`;

/** A request's class: the stream's own (pointer, header, part, text) or other. */
const classOf = (u) => {
  const p = new URL(u).pathname;
  if (!p.startsWith('/s/')) return 'other';
  if (p.startsWith('/s/headers/')) return 'header';
  if (p.endsWith('/pointer')) return 'pointer';
  if (/\/\d+\.text$/.test(p)) return 'text';
  if (/\/\d+$/.test(p)) return 'part';
  return 'other';
};

async function arm({ browser, url, tier, VIEWPORTS }) {
  const ctx = await browser.newContext({ ...VIEWPORTS[tier] });
  try {
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage(), errors = [], reqs = [], bodies = [];
    page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
    // Every request, the worker's included, with when it was made; every response body kept for the scan.
    ctx.on('request', (r) => reqs.push({ at: Date.now(), url: r.url() }));
    ctx.on('response', (r) => void r.body().then((b) => bodies.push([r.url(), b]), () => {}));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.v2?.souls?.copy.souls.size >= 1000 && [...window.v2.souls.copy.souls.values()].filter((s) => s.name).length >= 1000, null, { timeout: 120_000, polling: 500 });
    // Look along the line of Souls from its start, where the talkers stand.
    await page.evaluate(() => { const T = window.v2; T.cam.look(new T.cam.camera.position.constructor(6, 0, 0), 0.9, -0.35, 22); });
    await page.waitForTimeout(o.warm * 1000);
    // Open a Soul's page by clicking its chip, as a person would.
    const chip = await page.evaluate(() => window.v2.souls.placed.find((p) => !p.speech) ?? null);
    if (!chip) throw new Error('no chip on screen to click');
    await page.mouse.click(chip.x + chip.w / 2, chip.y + chip.h / 2);
    await page.waitForTimeout(500);
    const opened = await page.evaluate(() => { const a = document.querySelector('aside'); return a && a.style.display !== 'none' ? a.innerText.slice(0, 300) : null; });
    const from = Date.now();
    await page.evaluate(() => { window.__w4.frames = []; window.__w4.on = true; });
    const load = loadavg()[0];
    await page.waitForTimeout(o.measure * 1000);
    const d = await page.evaluate(() => {
      window.__w4.on = false;
      const S = window.v2.souls;
      return { frames: window.__w4.frames, souls: S.copy.souls.size, placed: S.placed.length, speech: S.placed.filter((p) => p.speech).length };
    });
    const win = reqs.filter((r) => r.at >= from && r.at < from + o.measure * 1000);
    const byClass = {};
    for (const r of win) byClass[classOf(r.url)] = (byClass[classOf(r.url)] ?? 0) + 1;
    const others = win.filter((r) => classOf(r.url) === 'other').map((r) => new URL(r.url).pathname);
    const secret = Buffer.from(SECRET);
    const hits = bodies.filter(([, b]) => b.includes(secret)).map(([u]) => new URL(u).pathname);
    const dt = d.frames.slice(1).map((t, i) => t - d.frames[i]);
    const median = q(dt, 0.5), p95 = q(dt, 0.95), bar = tier === 'phone' ? 33.3 : 16.7;
    return {
      tier, load: +load.toFixed(2), souls: d.souls, labelsDrawn: d.placed, speechDrawn: d.speech, soulPage: opened,
      a1: { requests: win.length, byClass, others },
      a2: { frames: dt.length, medianMs: r1(median), p95Ms: r1(p95), bar, holds: median <= bar && p95 <= 2 * bar },
      a4: { responsesScanned: bodies.length, streamResponses: bodies.filter(([u]) => classOf(u) !== 'other').length, whisperHits: hits },
      errors,
    };
  } finally {
    await ctx.close();
  }
}

const work = mkdtempSync(join(tmpdir(), 'v2-w4-'));
const w = await world(work);
const server = await vite(w.www);
const url = `http://127.0.0.1:${o.port}/?stream=/s/${w.stream}`;
try {
  if (o.hold) {
    log(`page ${url}`);
    await new Promise((r) => setTimeout(r, o.hold * 1000));
  } else {
    const { resolvePlaywright, browsersPath, launchArgs } = await imp('tools/playtest/lib/platform.mjs');
    const { VIEWPORTS } = await imp('tools/proof/clip-presets.mjs');
    browsersPath();
    const pw = resolvePlaywright();
    const browser = await pw.chromium.launch({ headless: true, args: launchArgs().args });
    const probe = await browser.newPage();
    const gl = await probe.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2'); return g.getParameter(g.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL); });
    await probe.close();
    log(`renderer ${gl}`);
    const rows = [];
    for (let rep = 1; rep <= o.repeats; rep++) for (const tier of String(o.tiers).split(',')) {
      const row = await arm({ browser, url, tier, VIEWPORTS }).catch((e) => ({ tier, error: String(e?.message ?? e).slice(0, 300) }));
      rows.push({ rep, ...row });
      log(JSON.stringify({ rep, ...row }));
    }
    await browser.close();
    // What the stream wrote: no file of the public stream holds the whisper.
    const { readdirSync } = await import('node:fs');
    const dir = join(w.www, w.stream);
    const files = readdirSync(dir);
    const onDisk = files.filter((f) => readFileSync(join(dir, f)).includes(Buffer.from(SECRET)));
    const res = { souls: o.souls, gl, measureS: o.measure, rows, streamFiles: files.length, whisperOnDisk: onDisk };
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, 'measure.json'), JSON.stringify(res, null, 1));
    log(`wrote ${join(o.out, 'measure.json')}`);
  }
} finally {
  server.kill();
  w.stop();
  rmSync(work, { recursive: true, force: true });
}
