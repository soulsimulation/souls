// The checking library by the world's build hash (Engine v2 R5, #2699; v2/docs/intents.md rule 13).
//
// The world names its pinned build in the first frame: the SHA-256 multihash of the checker's .wasm file, `1220`
// and 64 hex digits. The client loads that file from its cache, or downloads it, and uses it only when the bytes
// hash to that name (`checker-not-the-build`), are a WASM module (`checker-not-wasm`) and import nothing
// (`checker-has-imports`). A wrong download is never cached. A hash proves the file arrived whole, not that it is
// honest: a lying checker fools only its own client, and the world still decides.
//
// The library runs in a worker thread with a time limit (`checker-timed-out`): WASM cannot be interrupted on its
// own thread, so the worker is ended. It is instantiated with an empty import object, so it has no file, network,
// clock or anything else to call; the worker gets an empty environment.
//
// As a command, for the `resync` bench (v2/tools/bench/resync): loads one build and prints what it took, as JSON.
//   node v2/client/src/sync/library.mjs --cache <dir> --build <1220...> --store <dir> [--ms 1000]

import { isMain } from '../../../../tools/lib/is-main.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/** A refusal, named as the world names them. */
export class Refused extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

/** The build hash of a file's bytes: `1220` and the SHA-256 digest, in lower-case hex (what `sha256sum` gives). */
export function buildHash(bytes) {
  return `1220${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Checks bytes against the build asked for; gives the compiled module. Refuses by name. */
export function check(bytes, build) {
  const got = buildHash(bytes);
  if (got !== build) throw new Refused('checker-not-the-build', `asked ${build}, got ${got}`);
  let module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Refused('checker-not-wasm', e.message);
  }
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    throw new Refused('checker-has-imports', imports.map((i) => `${i.module}.${i.name}`).join(', '));
  }
  return module;
}

/**
 * Loads the build the world names: from `cache` (a folder of `<build>.wasm`), or through `download(build)` (bytes),
 * then caches it. A cached file that does not hash to its name is downloaded again. Gives the bytes, where they came
 * from and how many bytes were downloaded.
 */
export async function load({ build, cache, download }) {
  if (!/^1220[0-9a-f]{64}$/.test(build)) throw new Refused('checker-not-the-build', `not a build hash: ${build}`);
  const path = join(cache, `${build}.wasm`);
  const cached = await readFile(path).catch(() => null);
  if (cached && buildHash(cached) === build) {
    check(cached, build);
    return { bytes: cached, from: 'cache', downloaded: 0 };
  }
  const bytes = new Uint8Array(await download(build));
  check(bytes, build);
  await mkdir(cache, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
  return { bytes, from: 'download', downloaded: bytes.length };
}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const instance = new WebAssembly.Instance(new WebAssembly.Module(workerData.bytes), {});
const f = workerData.name === null ? null : instance.exports[workerData.name];
parentPort.postMessage(f === null ? Object.keys(instance.exports) : f(...workerData.args));
`;

/**
 * Runs the library's export `name` with `args` in a worker, ended after `ms` (`checker-timed-out`). With `name`
 * null it only instantiates, and gives the export names.
 */
export function run(bytes, build, name, args = [], { ms = 1000 } = {}) {
  check(bytes, build);
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, {
      eval: true,
      workerData: { bytes, name, args },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Refused('checker-timed-out', `${name ?? 'instantiate'} ran past ${ms} ms`));
    }, ms);
    const done = (f) => (v) => {
      clearTimeout(timer);
      w.terminate();
      f(v);
    };
    w.once('message', done(resolve));
    w.once('error', done((e) => reject(new Refused('checker-failed', e.message))));
  });
}

async function main(argv) {
  const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const t0 = performance.now();
  const build = arg('--build');
  const got = await load({
    build,
    cache: arg('--cache'),
    download: (b) => readFile(join(arg('--store'), `${b}.wasm`)),
  });
  const exports = await run(got.bytes, build, null, [], { ms: Number(arg('--ms') ?? 1000) });
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ from: got.from, downloaded: got.downloaded, size: got.bytes.length, exports: exports.length, ms }));
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.log(JSON.stringify({ refused: e.code ?? 'error', detail: e.message }));
    process.exit(1);
  });
}
