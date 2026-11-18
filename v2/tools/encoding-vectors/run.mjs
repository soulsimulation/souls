// Runs the encoding vectors (Engine v2 T0, #2639) through replica's WASM build and the cborg library, in Node, and
// checks that both give each vector's committed bytes. The native build runs the same files in
// crates/replica/tests/encoding.rs. Only this check uses cborg; the client and the page never do.
// Usage: node run.mjs <wasm-bindgen pkg dir> <fixtures dir>
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encode } from 'cborg';

const [pkgDir, fixtures] = process.argv.slice(2);
if (!pkgDir || !fixtures) throw new Error('usage: node run.mjs <pkg dir> <fixtures dir>');

const replica = await import(pathToFileURL(resolve(pkgDir, 'replica.js')).href);
replica.initSync({ module: readFileSync(join(pkgDir, 'replica_bg.wasm')) });

// Diagnostic notation, as far as the profile goes, to the values cborg takes: an integer beyond 2^53 as a BigInt,
// bytes as a Uint8Array, a map as a Map with integer keys.
function parse(text) {
  let pos = 0;
  const space = () => { while (/\s/.test(text[pos] ?? '')) pos++; };
  const eat = (c) => { space(); if (text[pos] === c) { pos++; return true; } return false; };
  const fail = (what) => { throw new Error(`${what} at column ${pos} of ${text}`); };
  const until = (end) => { const i = text.indexOf(end, pos); if (i < 0) fail('unclosed literal'); const s = text.slice(pos, i); pos = i + 1; return s; };
  const int = () => {
    space();
    const m = /^-?\d+/.exec(text.slice(pos)) ?? fail('expected a value');
    pos += m[0].length;
    const n = BigInt(m[0]);
    return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
  };
  const list = (close, item) => {
    if (eat(close)) return;
    for (;;) {
      item();
      if (eat(close)) return;
      if (!eat(',')) fail(`expected , or ${close}`);
    }
  };
  const value = () => {
    if (eat('h')) {
      if (!eat("'")) fail("expected h'");
      return Uint8Array.from(Buffer.from(until("'"), 'hex'));
    }
    if (eat('"')) return until('"');
    if (eat('[')) {
      const items = [];
      list(']', () => items.push(value()));
      return items;
    }
    if (eat('{')) {
      const map = new Map();
      list('}', () => {
        const key = int();
        if (!eat(':')) fail('expected :');
        map.set(key, value());
      });
      return map;
    }
    return int();
  };
  const v = value();
  space();
  if (pos !== text.length) fail('unexpected text');
  return v;
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const files = readdirSync(fixtures).filter((f) => f.endsWith('.txt')).sort();
let failures = 0;
for (const file of files) {
  const [line, want] = readFileSync(join(fixtures, file), 'utf8').split('\n');
  const diag = line.split(' # ')[0];
  const wasm = hex(replica.encode_diagnostic(diag));
  const js = hex(encode(parse(diag)));
  const ok = wasm === want && js === want;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: wasm ${wasm === want ? 'same' : wasm}, cborg ${js === want ? 'same' : js}`);
}
const cborg = JSON.parse(readFileSync(new URL('node_modules/cborg/package.json', import.meta.url), 'utf8')).version;
console.log(`encoding-vectors: ${files.length} vectors, ${failures} differ (replica WASM in Node ${process.version}; cborg ${cborg})`);
if (files.length < 24 || failures) process.exit(1);
