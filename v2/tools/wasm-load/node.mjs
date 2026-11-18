// Loads replica's WASM build (wasm-bindgen --target web) in Node with initSync and checks that load_probe returns
// the native value (K1, #2638). Usage: node node.mjs <pkg dir> <input> <native value>
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkgDir, input, expected] = process.argv.slice(2);
if (!pkgDir || !input || !expected) throw new Error('usage: node node.mjs <pkg dir> <input> <native value>');

const replica = await import(pathToFileURL(resolve(pkgDir, 'replica.js')).href);
replica.initSync({ module: readFileSync(join(pkgDir, 'replica_bg.wasm')) });
const value = String(replica.load_probe(Number(input)));

console.log(`node: load_probe(${input}) = ${value} (native ${expected})`);
if (value !== expected) {
  console.error('node: the WASM build returned a different value from the native build');
  process.exit(1);
}
