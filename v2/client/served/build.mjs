#!/usr/bin/env node
// The files a world serves for its agents (Engine v2 R17, #2818), built once per release from v2/client:
//
//   eden.mjs          the client, one file: the thin command and the daemon (v2/client/src, and what it imports),
//                     carried inside a loader (`loader.mjs`) that unpacks them into the home once. It states its
//                     version in one line, `const VERSION = "x.y.z";` (docs/architecture/api.md, frozen)
//   skill.md          the agent's skill (v2/client/skill/SKILL.md), `name: souls`, stamped with the version
//   creator.md        the creator's skill (v2/client/skills/creator.md, G7 #2796), when it is there
//                     A package those modules import by name (zod, for the land verbs' `packages/ground`) rides along
//                     as `node_modules/<name>/`: its package.json and its ESM entry's files, so Node finds it there
//   instructions.md   how to start, in one line (`instructions.md` beside this file)
//   replica.js, replica_bg.wasm   the daemon's library (replica's wasm-bindgen package), fetched apart and by hash
//   soul-client.json  `soulClient` as `/v1/config` gives it: {contract, version, bytes, sha256, minVersion, skill,
//                     files: [{name, version, bytes, sha256}]}, every served file but itself
//
//   node v2/client/served/build.mjs --out <dir> --version <x.y.z> [--min <x.y.z>] [--pkg <wasm-bindgen pkg dir>]
//
// The version is stamped at release (docs/process/versioning.md), never in a pull request.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../..');
const CLIENT = resolve(here, '..');
/** What this client speaks: the gateway's intents (I1), not today's edge API. */
export const CONTRACT = 'souls-v2/1';
export const ENTRY = 'v2/client/src/cli/souls.mjs';
const VERSION = /^\d+\.\d+\.\d+$/;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Every file of v2/client/src but its tests, and whatever they import by a relative path, closed; repo-relative. */
export function payloadFiles() {
  const out = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|json)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) out.add(relative(REPO, p));
    }
  };
  walk(join(CLIENT, 'src'));
  const todo = [...out].filter((f) => f.endsWith('.mjs'));
  while (todo.length) {
    const f = todo.pop();
    const text = readFileSync(join(REPO, f), 'utf8');
    for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)) {
      const dep = relative(REPO, resolve(REPO, dirname(f), m[1]));
      if (!out.has(dep) && existsSync(join(REPO, dep))) { out.add(dep); if (/\.(mjs|ts)$/.test(dep)) todo.push(dep); }
    }
  }
  return [...out].sort();
}

/** The packages the payload's modules import by name (not `node:`), each with the payload file that imports it. */
export function namedImports(files = payloadFiles()) {
  const named = new Map();
  for (const f of files.filter((f) => /\.(mjs|ts)$/.test(f))) {
    const text = readFileSync(join(REPO, f), 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"./][^'"]*)['"]|\bimport\(\s*['"]([^'"./][^'"]*)['"]\s*\)/gm)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('node:')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!named.has(name)) named.set(name, f);
    }
  }
  return named;
}

/** A named package as served files, `node_modules/<name>/<path>` → text: its package.json and the files its ESM entry
 *  imports, closed over relative imports. Resolved as the importing file resolves it; a package not installed there
 *  stops the build, so a release never serves a client whose land verbs cannot load. */
export function vendored(name, from) {
  let pj;
  try { pj = createRequire(join(REPO, from)).resolve(`${name}/package.json`); } catch (e) {
    throw new Error(`${from} imports ${name}, which is not installed (pnpm install --frozen-lockfile --filter @souls/ground): ${e.message}`);
  }
  const dir = dirname(pj), pkg = JSON.parse(readFileSync(pj, 'utf8'));
  const dot = pkg.exports?.['.'] ?? pkg.exports;
  const entry = (typeof dot === 'string' ? dot : dot?.import ?? dot?.default) ?? pkg.module ?? pkg.main ?? 'index.js';
  const files = { [`node_modules/${name}/package.json`]: readFileSync(pj, 'utf8') };
  const todo = [resolve(dir, entry)];
  while (todo.length) {
    const f = todo.pop(), key = `node_modules/${name}/${relative(dir, f)}`;
    if (files[key] !== undefined) continue;
    const text = readFileSync(f, 'utf8');
    files[key] = text;
    for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)) {
      const dep = resolve(dirname(f), m[1]);
      if (dep.startsWith(dir) && existsSync(dep)) todo.push(dep);
    }
  }
  return files;
}

/** The skill with its version stamped: the frontmatter's `version:` and the client's version in its text. */
export function stampSkill(text, version) {
  if (!/^---\n[\s\S]*?^name: souls$/m.test(text)) throw new Error('the skill must keep `name: souls`');
  return text.replace(/^(\s*version:\s*)"?[0-9][0-9.]*"?\s*$/m, `$1"${version}"`)
    .replace(/(souls\.mjs )\d+\.\d+\.\d+/g, `$1${version}`)
    .replace(/(skill )\d+\.\d+\.\d+/, `$1${version}`);
}

/** Builds the served set into `out`; gives the `soulClient` it wrote. */
export function build({ out, version, min = '0.0.0', pkg }) {
  if (!VERSION.test(version) || !VERSION.test(min)) throw new Error('--version and --min are x.y.z');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const payload = payloadFiles();
  const files = Object.fromEntries(payload.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]));
  for (const [name, from] of namedImports(payload)) Object.assign(files, vendored(name, from));
  const loader = readFileSync(join(here, 'loader.mjs'), 'utf8');
  writeFileSync(join(out, 'eden.mjs'), `#!/usr/bin/env node\n// Souls client ${version} (Engine v2 R17): start with \`node eden.mjs pair <world>\`.\n` +
    `const VERSION = "${version}";\nconst ENTRY = ${JSON.stringify(ENTRY)};\nconst FILES = ${JSON.stringify(files)};\n${loader}`);
  writeFileSync(join(out, 'skill.md'), stampSkill(readFileSync(join(CLIENT, 'skill/SKILL.md'), 'utf8'), version));
  if (existsSync(join(CLIENT, 'skills/creator.md'))) copyFileSync(join(CLIENT, 'skills/creator.md'), join(out, 'creator.md'));
  writeFileSync(join(out, 'instructions.md'), readFileSync(join(here, 'instructions.md'), 'utf8'));
  if (pkg) for (const f of ['replica.js', 'replica_bg.wasm']) copyFileSync(join(pkg, f), join(out, f));
  const described = (name) => { const b = readFileSync(join(out, name)); return { name, version, bytes: b.length, sha256: sha256(b) }; };
  const listed = readdirSync(out).sort().map(described);
  const of = (n) => { const { name, ...d } = listed.find((f) => f.name === n); return d; };
  const { version: _v, ...client } = of('eden.mjs');
  const soulClient = { contract: CONTRACT, version, ...client, minVersion: min, skill: of('skill.md'), files: listed };
  writeFileSync(join(out, 'soul-client.json'), JSON.stringify(soulClient, null, 2) + '\n');
  return soulClient;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  if (!opt('--out') || !opt('--version')) {
    process.stderr.write('usage: build.mjs --out <dir> --version <x.y.z> [--min <x.y.z>] [--pkg <dir>]\n');
    process.exit(2);
  }
  const c = build({ out: resolve(opt('--out')), version: opt('--version'), min: opt('--min'), pkg: opt('--pkg') && resolve(opt('--pkg')) });
  for (const f of c.files) console.log(`served: ${f.name.padEnd(16)} ${f.version}  ${f.bytes} bytes  ${f.sha256}`);
}
