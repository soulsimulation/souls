// V5b (#3460) A2 and A3, end to end: a local world where nothing moves (`worldd gateway-link --www`, built by `cargo
// build -p worldd`) writes part 0 and then only marks its pointer quiet; the page's worker (worker.ts, with the WASM
// replica from v2/tools/ci.sh) and its clock (`caughtUp`) start drawing within 3 s and stay live as world time passes.
// Then one Soul speaks: its part is played and the clock passes the moment within the usual lag. No browser here; the
// headless-browser run is the PR's proof.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode, encode } from 'cborg';
import { BEHIND_US, PlaybackClock, caughtUp } from '../clock/clock.ts';
import type { PartRec, Pointer } from './source.ts';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = resolve(v2, process.env.V2_REPLICA_PKG ?? 'target/wasm-load/pkg');
const worldd = resolve(v2, 'target/debug/worldd');
for (const f of [join(pkg, 'replica.js'), worldd]) assert.ok(existsSync(f), `${f}: run v2/tools/ci.sh's wasm steps and cargo build -p worldd`);
const replicaUrl = pathToFileURL(join(pkg, 'replica.js')).href;
registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: replicaUrl, shortCircuit: true } : next(s, c)) });
const replica = await import(replicaUrl);
replica.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });

const work = mkdtempSync(join(tmpdir(), 'v2-still-'));
const www = join(work, 'www');
const timers: ReturnType<typeof setInterval>[] = [];
let world: ReturnType<typeof spawn> | null = null;
after(() => {
  timers.forEach(clearInterval);
  world?.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
});
const realSetInterval = globalThis.setInterval;
(globalThis as { setInterval: unknown }).setInterval = (f: () => void, ms: number) => {
  const t = realSetInterval(f, ms);
  timers.push(t);
  return t;
};
globalThis.fetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  if (url.protocol === 'file:') return new Response(readFileSync(url), { headers: { 'content-type': 'application/wasm' } });
  const file = normalize(join(www, decodeURIComponent(url.pathname.slice(3))));
  if (!file.startsWith(www) || !existsSync(file)) return new Response(null, { status: 404 });
  return new Response(readFileSync(file));
}) as typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a still world is drawn within 3 s and stays live; a Soul that speaks after it is played within the lag', async () => {
  const sock = join(work, 'w.sock');
  world = spawn(worldd, ['gateway-link', '--socket', sock, '--lineage', 'ef'.repeat(16), '--epoch', '1', '--log', join(work, 'log'), '--rooms', '1', '--bodies', '3', '--no-measures', '--www', www], { stdio: ['ignore', 'pipe', 'inherit'] });
  const bodies: string[] = [];
  const streamDir = await new Promise<string>((ok, no) => {
    world!.once('exit', (c) => no(new Error(`worldd exited ${c}`)));
    createInterface({ input: world!.stdout! }).on('line', (l) => {
      if (l.startsWith('body ')) bodies.push(l.slice(5));
      if (l.startsWith('stream ')) ok(l.slice(7));
    });
  });
  // The page loads a little after the world starts, as a visitor would.
  await sleep(1500);

  const parts: PartRec[] = [];
  const errors: string[] = [];
  let pointer: Pointer | null = null;
  const self = { postMessage: (m: { t: string; p: never; message: string }) => (m.t === 'part' ? parts.push(m.p) : m.t === 'pointer' ? (pointer = m.p) : errors.push(m.message)), onmessage: null as null | ((e: unknown) => void) };
  (globalThis as { self?: unknown }).self = self;
  await import('./worker.ts');
  const loaded = Date.now();
  self.onmessage!({ data: { stream: `http://local/s/${streamDir.replace(/\/?$/, '/')}` } });

  // The page's frame loop, as main.ts runs it: world-now from the pointer's anchor, the clock to the caught-up time.
  const clock = new PlaybackClock();
  let newestTo: number | null = null;
  let started: number | null = null;
  let last = Date.now();
  const worldNow = () => (pointer ? pointer.anchorWorld + (Date.now() - pointer.anchorWallMs) * 1000 : null);
  const frame = () => {
    const now = Date.now(), dt = now - last;
    last = now;
    newestTo = parts.at(-1)?.to ?? null;
    const w = worldNow();
    const t = w === null ? null : clock.step(dt, w, caughtUp(newestTo, pointer?.quietUntil));
    if (t !== null && started === null) started = now - loaded;
    return t;
  };
  const run = async (ms: number, each?: (t: number | null) => void) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = frame();
      each?.(t);
      await sleep(16);
    }
  };

  // A2: drawing starts within 3 s of page load, on part 0 and the pointer's quiet time alone.
  await run(3000);
  assert.deepEqual(errors, []);
  assert.ok(started !== null && started <= 3000, `started drawing ${started} ms after load`);
  assert.equal(parts.length, 1, 'a still world writes part 0 only');
  // A2: live as world time passes, about 2 s behind the world, never stepping back.
  const t0 = clock.t!;
  let prev = t0, worst = 0;
  await run(6000, (t) => {
    assert.ok(t !== null && t >= prev, 'the clock stepped back');
    prev = t!;
    worst = Math.max(worst, worldNow()! - t!);
  });
  assert.equal(parts.length, 1, 'no empty parts');
  assert.ok(clock.t! - t0 >= 5_500_000, `world time drawn moved ${(clock.t! - t0) / 1e6} s in 6 s`);
  assert.ok(worst <= BEHIND_US + 500_000, `at most ${(worst / 1e6).toFixed(2)} s behind the world`);
  console.log(`A2: drawing started ${started} ms after load; ${((clock.t! - t0) / 1e6).toFixed(2)} s of world time drawn in 6 s, at most ${(worst / 1e6).toFixed(2)} s behind`);

  // A3: a Soul speaks after the still while; its part is played and the clock passes that moment within the lag.
  const conn = createConnection(sock);
  await new Promise((r) => conn.once('connect', r));
  conn.on('data', () => {});
  const [scope, counter] = bodies[0].split('-');
  const intent = decode(replica.wireIntent(Buffer.from(scope, 'hex'), BigInt(counter), 'eden:say', 1n, new Uint8Array(), BigInt((Date.now() + 60_000) * 1000), ''), { useMaps: true }) as Map<number, unknown>;
  intent.set(4, new Map([[1, new Map([[23, new TextEncoder().encode('after a long quiet')]])]]));
  const out = encode(intent), len = Buffer.alloc(4);
  len.writeUInt32BE(out.length);
  const said = worldNow()!;
  conn.write(Buffer.concat([len, out]));
  let heard: number | null = null, passed: number | null = null;
  await run(5000, (t) => {
    if (heard === null && parts.some((p) => p.said?.some((s) => s.words === 'after a long quiet'))) heard = worldNow()! - said;
    if (heard !== null && passed === null && t !== null && t >= said) passed = worldNow()! - said;
  });
  conn.destroy();
  assert.deepEqual(errors, []);
  assert.ok(heard !== null && heard <= 2_000_000, `the part was played ${heard} µs after the words`);
  assert.ok(passed !== null && passed <= BEHIND_US + 500_000, `the clock passed the words ${passed} µs after them`);
  console.log(`A3: the words' part was played ${(heard / 1e6).toFixed(2)} s after them; drawn ${(passed / 1e6).toFixed(2)} s after them`);
});
