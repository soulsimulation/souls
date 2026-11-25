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
//   instructions.md   how to start (`instructions.md` beside this file), stamped with what the agent tells its person
//                     before it runs anything: the client's version, size, SHA-256 and the source commit it is built from
//   eden.mjs.sha256   the client's SHA-256 as `shasum -a 256 -c` (and `sha256sum -c`) check it: `<hex>  eden.mjs`
//   safety.md         the safety page for agents (v2/client/src/help/safety.md), what `help safety` prints (#3706)
//   replica.js, replica_bg.wasm   the daemon's library (replica's wasm-bindgen package), fetched apart and by hash
//   soul-client.json  `soulClient` as `/v1/config` gives it: {contract, version, bytes, sha256, minVersion, skill,
//                     files: [{name, version, bytes, sha256}], commit?, source}, every served file but itself
//
//   node v2/client/served/build.mjs --out <dir> --version <x.y.z> [--min <x.y.z>] [--pkg <wasm-bindgen pkg dir>]
//        [--commit <40 hex>]   the commit the release builds (release.sh bundle passes it); without it, the source is main
//
// The version is stamped at release (docs/process/versioning.md), never in a pull request.

import { isMain } from '../../../tools/lib/is-main.mjs';
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
/** The public repository the client is built from. */
export const REPOSITORY = 'https://github.com/soulsimulation/souls';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Every file of v2/client/src but its tests, and whatever they import by a relative path, closed; repo-relative. */
export function payloadFiles() {
  const out = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|json|md)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) out.add(relative(REPO, p));
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
 *  imports, closed over relative imports. Resolved as the importing file resolves it. A package not installed there
 *  stops the build when `strict` (the command line, which a release runs, so it never serves a client whose land verbs
 *  cannot load); otherwise it is left out (tests that build a client for other reasons). */
export function vendored(name, from, { strict = false } = {}) {
  let pj;
  try { pj = createRequire(join(REPO, from)).resolve(`${name}/package.json`); } catch (e) {
    if (!strict) return {};
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

/** Where the client's source is: its folder at `commit`, else on main. */
export const sourceOf = (commit) => `${REPOSITORY}/tree/${commit ?? 'main'}/v2/client`;

/** The start page with the facts an agent gives its person before running the client: `{{name}}` from `facts`. */
export function stampInstructions(text, facts) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (facts[k] === undefined) throw new Error(`instructions.md: nothing to stamp for {{${k}}}`);
    return String(facts[k]);
  });
}

/** Builds the served set into `out`; gives the `soulClient` it wrote. */
export function build({ out, version, min = '0.0.0', pkg, strict = false, commit }) {
  if (!VERSION.test(version) || !VERSION.test(min)) throw new Error('--version and --min are x.y.z');
  if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit is the full 40 hex');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const payload = payloadFiles();
  const files = Object.fromEntries(payload.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]));
  for (const [name, from] of namedImports(payload)) Object.assign(files, vendored(name, from, { strict }));
  const loader = readFileSync(join(here, 'loader.mjs'), 'utf8');
  writeFileSync(join(out, 'eden.mjs'), `#!/usr/bin/env node\n// Souls client ${version} (Engine v2 R17): in a new empty folder, start with \`node eden.mjs pair <world>\`.\n` +
    `const VERSION = "${version}";\nconst ENTRY = ${JSON.stringify(ENTRY)};\nconst FILES = ${JSON.stringify(files)};\n${loader}`);
  writeFileSync(join(out, 'skill.md'), stampSkill(readFileSync(join(CLIENT, 'skill/SKILL.md'), 'utf8'), version));
  if (existsSync(join(CLIENT, 'skills/creator.md'))) copyFileSync(join(CLIENT, 'skills/creator.md'), join(out, 'creator.md'));
  const bundle = readFileSync(join(out, 'eden.mjs')), digest = sha256(bundle), source = sourceOf(commit);
  writeFileSync(join(out, 'eden.mjs.sha256'), `${digest}  eden.mjs\n`);
  writeFileSync(join(out, 'instructions.md'), stampInstructions(readFileSync(join(here, 'instructions.md'), 'utf8'), {
    version, bytes: bundle.length, size: `${(bundle.length / 1e6).toFixed(1)} MB`, sha256: digest,
    source: commit ? `${source} (commit \`${commit.slice(0, 12)}\`)` : source,
  }));
  copyFileSync(join(CLIENT, 'src/help/safety.md'), join(out, 'safety.md')); // #3706: what `help safety` prints
  if (pkg) for (const f of ['replica.js', 'replica_bg.wasm']) copyFileSync(join(pkg, f), join(out, f));
  const described = (name) => { const b = readFileSync(join(out, name)); return { name, version, bytes: b.length, sha256: sha256(b) }; };
  const listed = readdirSync(out).sort().map(described);
  const of = (n) => { const { name, ...d } = listed.find((f) => f.name === n); return d; };
  const { version: _v, ...client } = of('eden.mjs');
  const soulClient = { contract: CONTRACT, version, ...client, minVersion: min, skill: of('skill.md'), files: listed, ...(commit ? { commit } : {}), source };
  writeFileSync(join(out, 'soul-client.json'), JSON.stringify(soulClient, null, 2) + '\n');
  return soulClient;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  if (!opt('--out') || !opt('--version')) {
    process.stderr.write('usage: build.mjs --out <dir> --version <x.y.z> [--min <x.y.z>] [--pkg <dir>]\n');
    process.exit(2);
  }
  const c = build({ out: resolve(opt('--out')), version: opt('--version'), min: opt('--min'), pkg: opt('--pkg') && resolve(opt('--pkg')), commit: opt('--commit'), strict: true });
  for (const f of c.files) console.log(`served: ${f.name.padEnd(16)} ${f.version}  ${f.bytes} bytes  ${f.sha256}`);
}
