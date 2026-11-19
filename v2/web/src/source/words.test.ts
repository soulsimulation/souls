// V1b (#3361) A3 and A4, end to end: a local world (`worldd gateway-link --www`, built by `cargo build -p worldd`)
// takes a say, a whisper and a describe over its socket, keeps their words in K16's store and writes its public stream
// with a text file beside each part; the page's worker (worker.ts, with the WASM replica from v2/tools/ci.sh) plays
// that stream and hands on each said sentence with its words, and a body's name and description, within the stream's
// lag. Only the worker's fetch is served from the stream's folder here, as V2 would serve it; no browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode, encode } from 'cborg';
import type { PartRec } from './source.ts';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = resolve(v2, process.env.V2_REPLICA_PKG ?? 'target/wasm-load/pkg');
const worldd = resolve(v2, 'target/debug/worldd');
/** The stream's lag: V1's A3 bound on how far the page plays behind the world. */
const LAG_MS = 2500;

for (const f of [join(pkg, 'replica.js'), worldd]) assert.ok(existsSync(f), `${f}: run v2/tools/ci.sh's wasm steps and cargo build -p worldd`);
// worker.ts imports `replica` as the page's bundler names it.
const replicaUrl = pathToFileURL(join(pkg, 'replica.js')).href;
registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: replicaUrl, shortCircuit: true } : next(s, c)) });
const replica = await import(replicaUrl);
replica.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });

const work = mkdtempSync(join(tmpdir(), 'v2-words-'));
const www = join(work, 'www');
const timers: ReturnType<typeof setInterval>[] = [];
let world: ReturnType<typeof spawn> | null = null;
after(() => {
  timers.forEach(clearInterval);
  world?.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
});

// The worker's fetch: the WASM file from disk, the stream from its folder (uncached, a miss is a 404).
const fetched: string[] = [];
globalThis.fetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  if (url.protocol === 'file:') return new Response(readFileSync(url), { headers: { 'content-type': 'application/wasm' } });
  const file = normalize(join(www, decodeURIComponent(url.pathname.slice(3))));
  fetched.push(url.pathname);
  if (!file.startsWith(www) || !existsSync(file)) return new Response(null, { status: 404 });
  return new Response(readFileSync(file));
}) as typeof fetch;

test('a said sentence, and a name and description, reach the page through the worker within the lag', async () => {
  const sock = join(work, 'w.sock');
  const lineage = 'ab'.repeat(16);
  world = spawn(worldd, ['gateway-link', '--socket', sock, '--lineage', lineage, '--epoch', '1', '--log', join(work, 'log'), '--rooms', '1', '--bodies', '3', '--no-measures', '--www', www], { stdio: ['ignore', 'pipe', 'inherit'] });
  const bodies: string[] = [];
  const streamDir = await new Promise<string>((ok, no) => {
    world!.once('exit', (c) => no(new Error(`worldd exited ${c}`)));
    createInterface({ input: world!.stdout! }).on('line', (l) => {
      if (l.startsWith('body ')) bodies.push(l.slice(5));
      if (l.startsWith('stream ')) ok(l.slice(7));
    });
  });
  assert.equal(bodies.length, 3);
  while (!existsSync(sock)) await new Promise((r) => setTimeout(r, 20));

  // The socket: a 4-byte big-endian length, then the frame; answers come back the same way.
  const conn = createConnection(sock);
  await new Promise((r) => conn.once('connect', r));
  let buf = Buffer.alloc(0);
  const answers: Uint8Array[] = [];
  conn.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      answers.push(buf.subarray(4, 4 + buf.readUInt32BE(0)));
      buf = buf.subarray(4 + buf.readUInt32BE(0));
    }
  });
  const seqs = new Map<string, number>();
  const send = (body: string, verb: string, target: string, params: Map<number, unknown>) => {
    const [scope, counter] = body.split('-');
    const seq = (seqs.get(body) ?? 0) + 1;
    seqs.set(body, seq);
    const expiry = (Date.now() + 60_000) * 1000;
    const bytes = replica.wireIntent(Buffer.from(scope, 'hex'), BigInt(counter), verb, BigInt(seq), new Uint8Array(), BigInt(expiry), target);
    const intent = decode(bytes, { useMaps: true }) as Map<number, unknown>;
    intent.set(4, params);
    const out = encode(intent);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(out.length);
    conn.write(Buffer.concat([len, out]));
  };
  const words = (w: string) => new Map([[23, new TextEncoder().encode(w)]]);

  // The page's worker, as the page starts it.
  const parts: PartRec[] = [];
  const errors: string[] = [];
  const realSetInterval = globalThis.setInterval;
  (globalThis as { setInterval: unknown }).setInterval = (f: () => void, ms: number) => {
    const t = realSetInterval(f, ms);
    timers.push(t);
    return t;
  };
  const self = { postMessage: (m: { t: string; p: PartRec; message: string }) => (m.t === 'part' ? parts.push(m.p) : m.t === 'error' && errors.push(m.message)), onmessage: null as null | ((e: unknown) => void) };
  (globalThis as { self?: unknown }).self = self;
  await import('./worker.ts');
  self.onmessage!({ data: { stream: `http://local/s/${streamDir.replace(/\/?$/, '/')}` } });

  // A busy world: the third body talks every 200 ms, so each stretch of the stream is cut as it would be.
  const [a, b, c] = bodies;
  const busy = realSetInterval(() => send(c, 'eden:say', '', new Map([[1, words('hm')]])), 200);
  timers.push(busy);
  await new Promise((r) => setTimeout(r, 600));
  const sentence = 'the bread is still warm';
  const secret = 'the key is under the third stone';
  send(b, 'eden:whisper', a, new Map([[1, words(secret)]]));
  send(a, 'eden:describe', '', new Map([[1, words('Oriel')], [2, words('keeps the lamps of the east room')]]));
  const sent = Date.now();
  send(a, 'eden:say', '', new Map([[1, words(sentence)]]));

  const key = (id: string) => { const [s, n] = id.split('-'); return `${s}.${n}`; };
  const heard = () => parts.flatMap((p) => p.said ?? []).find((s) => s.words === sentence);
  while (!heard() && Date.now() - sent < 10_000 && !errors.length) await new Promise((r) => setTimeout(r, 10));
  const delay = Date.now() - sent;
  assert.deepEqual(errors, []);
  const s = heard();
  assert.ok(s, `the said sentence reached the page: ${JSON.stringify(parts.flatMap((p) => p.said ?? []))}`);
  assert.equal(s.speaker, key(a));
  assert.ok(s.length >= 500_000);
  assert.ok(delay <= LAG_MS, `A3: arrived ${delay} ms after it was said (lag ${LAG_MS} ms)`);
  console.log(`A3: "${sentence}" reached the worker ${delay} ms after it was said, in part ${parts.find((p) => p.said?.includes(s))?.number}`);

  // A4: the body's public name and description, from its node, with their words.
  const named = parts.flatMap((p) => p.nodes).filter((n) => n.id === key(a) && n.name);
  assert.equal(named.at(-1)?.name, 'Oriel');
  assert.equal(named.at(-1)?.description, 'keeps the lamps of the east room');
  console.log(`A4: ${key(a)} is "${named.at(-1)?.name}", "${named.at(-1)?.description}"`);

  // A whisper is in no part the page played, and in no file of the public stream.
  assert.ok(!parts.flatMap((p) => p.said ?? []).some((x) => x.words === secret || x.speaker === key(b)));
  const dir = join(www, streamDir);
  const texts = readdirSync(dir).filter((f) => f.endsWith('.text'));
  assert.ok(texts.length > 0 && fetched.some((f) => f.endsWith('.text')));
  for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f)).includes(secret), `${f} holds no whispered words`);
  assert.ok(answers.length > 0);
});
