// The `replica-equal` bench (Engine v2 R1, #2684), WASM half: loads replica's WASM build (wasm-bindgen --target web,
// with the `vectors` feature) in Node and runs it on what main.rs wrote, comparing each answer with the native build's.
//   A1: T6's golden fixtures, the base's batch then each fixture's: the same answer bytes (each carries a chain of
//       every step's hash and the state hash after it) and the same state hash.
//   A2: the generated stream, in batches: the same answer bytes for every batch, and the same state at the end.
//   A3: every case of crates/replica/tests/queries.txt answers as written, as the native test checks.
//   A4: effects applied a second (best of 3, no hashing), the .wasm file's size, and its start time in Node.
// Usage, from v2/: node tools/bench/replica-equal/node.mjs <pkg dir> <out dir> <queries.txt>
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkgDir, outDir, queriesPath] = process.argv.slice(2);
if (!pkgDir || !outDir || !queriesPath) {
  throw new Error('usage: node node.mjs <pkg dir> <out dir> <queries.txt>');
}

// Start: import the bindings, read the file, compile and instantiate it synchronously (Node allows it; a page uses
// the asynchronous init()).
const wasmPath = join(pkgDir, 'replica_bg.wasm');
const t0 = performance.now();
const r = await import(pathToFileURL(resolve(pkgDir, 'replica.js')).href);
r.initSync({ module: readFileSync(wasmPath) });
const startMs = performance.now() - t0;

const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const header = readFileSync(join(outDir, 'header.bin'));
let failures = 0;
const fail = (what) => {
  failures += 1;
  console.error(`wasm: DIFFERENT ${what}`);
};

// A1.
const fixtures = JSON.parse(readFileSync(join(outDir, 'fixtures.json'), 'utf8'));
const base = bytes(fixtures['0-base'].batch);
let fixtureSteps = 0;
for (const [name, f] of Object.entries(fixtures)) {
  if (name === '0-base') continue;
  const rep = new r.Replica(header);
  const got = [rep.applyBatch(base, true), rep.applyBatch(bytes(f.batch), true)].map(hex);
  if (got.join() !== f.answers.join()) fail(`${name}: answers ${got} (native ${f.answers})`);
  if (hex(rep.stateHash()) !== f.state) fail(`${name}: state ${hex(rep.stateHash())} (native ${f.state})`);
  fixtureSteps += 2;
  rep.free();
}
console.log(`wasm A1: ${Object.keys(fixtures).length - 1} golden fixtures, ${fixtureSteps} steps, answers and states as native`);

// A3.
const rep = new r.Replica(header);
rep.applyBatch(base, false);
rep.applyBatch(bytes(fixtures['5-link'].batch), false);
let cases = 0;
for (const line of readFileSync(queriesPath, 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const name = line.slice(0, line.indexOf(': '));
  const [query, answer] = line.slice(name.length + 2).split(' => ').map((s) => s.trim());
  let got;
  try {
    got = hex(rep.query(r.encode_diagnostic(query)));
  } catch (e) {
    got = `refused ${String(e.message ?? e).split(':')[0]}`;
  }
  const want = answer.startsWith('refused ') ? answer : hex(r.encode_diagnostic(answer));
  if (got !== want) fail(`query ${name}: ${got} (want ${want})`);
  cases += 1;
}
rep.free();
console.log(`wasm A3: ${cases} query cases answer as queries.txt says`);

// A2.
const native = JSON.parse(readFileSync(join(outDir, 'native.json'), 'utf8'));
const stream = readFileSync(join(outDir, 'stream.bin'));
const batches = [];
for (let at = 0; at < stream.length; ) {
  const len = stream.readUInt32LE(at);
  batches.push(new Uint8Array(stream.buffer, stream.byteOffset + at + 4, len));
  at += 4 + len;
}
const eq = new r.Replica(header);
batches.forEach((b, i) => {
  const got = hex(eq.applyBatch(b, true));
  if (got !== native.answers[i]) fail(`stream batch ${i}: ${got} (native ${native.answers[i]})`);
});
const state = hex(eq.stateHash());
if (state !== native.state) fail(`stream state ${state} (native ${native.state})`);
if (BigInt(native.version) !== eq.version()) fail(`stream version ${eq.version()} (native ${native.version})`);
eq.free();
console.log(
  `wasm A2: ${native.effects} effects from seed ${native.seed} in ${batches.length} batches, the same answer for ` +
    `every batch and state ${state}`,
);

// A4.
let best = Infinity;
for (let run = 0; run < 3; run += 1) {
  const rr = new r.Replica(header);
  const t = performance.now();
  for (const b of batches) rr.applyBatch(b, false);
  best = Math.min(best, performance.now() - t);
  rr.free();
}
const rate = Math.round(native.effects / (best / 1000));
const size = statSync(wasmPath).size;
const report = { rate, nativeRate: native.rate, wasmBytes: size, startMs: Number(startMs.toFixed(1)), node: process.version };
writeFileSync(join(outDir, 'wasm.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `wasm A4: ${rate} effects applied a second (native ${native.rate}); replica_bg.wasm ${size} bytes; ` +
    `start ${startMs.toFixed(1)} ms in Node ${process.version}`,
);
if (failures) {
  console.error(`wasm: ${failures} differences from the native build`);
  process.exit(1);
}
