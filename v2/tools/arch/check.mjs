#!/usr/bin/env node
// Engine v2 K14 (#2648): checks of the architecture itself, a step of v2/tools/ci.sh. Each broken rule fails with
// its name, its trunk contract and the fix. First a self-test: every seeded violation in seeded/ must fail by its
// rule's name, or the check itself is broken. Then the tree. Rules and what they do not prove: README.md.
//
//   node v2/tools/arch/check.mjs          (from anywhere; exit 1 on a broken rule)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const V2 = resolve(HERE, '../..');
const REPO = resolve(V2, '..');

export const RULES = {
  'write-outside-own': {
    contract: 'TRUNK T1, v2/docs/zones.md rules 2 and 3',
    fix: 'a system writes only its own node (Own); change another node by a transfer, or let its own system read yours next tick',
  },
  'read-same-tick': {
    contract: 'TRUNK T1, v2/docs/zones.md rules 2 and 3',
    fix: 'read other nodes only through Prev, as of the previous tick; drop the shared state, or put both sides in one activity node',
  },
  'float-in-replica': {
    contract: 'TRUNK T0 and T5 (a verdict comes out the same natively and in WASM: integers only)',
    fix: 'use whole units (µm, µs, a Fraction or a Line); a drawing helper that needs floats goes on v2/tools/arch/floats.allow',
  },
  'crate-dependency': {
    contract: 'TRUNK T0 for replica (the shared library, native and WASM, keeps almost no dependencies); K14 for every crate',
    fix: 'remove the dependency, or add it to ALLOWED in v2/tools/arch/check.mjs in a reviewed change that says why',
  },
  'v2-imports-today': {
    contract: 'tranche #2635 (Engine v2 is written from nothing: v2/crates never use today\'s packages)',
    fix: 'port what you need into v2/, or read it as data a tool exports into .local/',
  },
  't1-check-wired': {
    contract: 'TRUNK T1, v2/docs/zones.md rule 3 (the runner\'s check, run by v2/crates/replica/tests/zones.rs)',
    fix: 'keep the planted systems of zones.rs a2 and the two fault names; K14 wires that test in, not a second one',
  },
};

/** A broken rule, as the job prints it. */
export const problem = (rule, where, what) => `${rule}: ${where}: ${what} [${RULES[rule].contract}] fix: ${RULES[rule].fix}`;

/** The dependencies each crate under v2/crates may have (normal, dev and build alike). A crate not listed fails. */
export const ALLOWED = {
  // wasmi: the code hatch's one interpreter, metered by its own fuel the same in every build (F8, #2823).
  replica: ['wasm-bindgen', 'wasmi'],
  // skills: the world wakes the form runner and steps the walk it starts (F1, #2766; K13a, #2676).
  sim: ['replica', 'i_overlay', 'i_triangle', 'import-eden', 'testworld', 'skills'],
  // O3 (#2732): the shipper writes pieces to the object store and moves the directory's mark. import-eden: E1's Eden
  // measures load Eden 2026's tree in a test (#2708; dev only). rustix: the machine's steady clock (CLOCK_MONOTONIC)
  // without unsafe, one clock for the world and its gateway across their local socket, so an act's stamps form one
  // chain (O4, #2694). skills: the world runs the built-in walk for a move intent; the test world in its tests (I4b,
  // #3156).
  // backup: O20's restore reads a served world's shipped stores back in its tests (O20b, #3523; dev only).
  worldd: ['replica', 'sim', 'directoryd', 'import-eden', 'rustix', 'skills', 'testworld', 'backup'],
  // Agents' sockets (I1, #2683): WebSocket on tokio through axum, a constant-time compare, the OS random source.
  // worldd: the world's view tier served to the gateway in the view subscription tests (#3292; dev only).
  gatewayd: ['replica', 'axum', 'tokio', 'subtle', 'getrandom', 'tokio-tungstenite', 'futures-util', 'rustix', 'worldd'],
  // The built-in skills reach the world through replica's host interface alone (T9, #2663).
  skills: ['replica'],
  // W8 (#2729): the object store's SigV4 signature (ring) and HTTP (ureq); sim's tick loop in a test (dev only).
  // W1 (#2704): RS256 checks and random ids (ring), the one-file account store (rusqlite), JWKS (serde_json, ureq).
  directoryd: ['replica', 'ring', 'rusqlite', 'serde_json', 'ureq', 'sim'],
  // O1 (#2730): the launcher reads a world's pin from its directory record.
  // O7 (#2804): the rehearsal reads a world's log and writes its scratch copy (K4's log).
  supervisor: ['replica', 'directoryd', 'sim'],
  // Uploads (G6, #2747): PNG pixel data inflated with a bound on its output; the child's rlimits on Linux; G1's commit
  // and K4's log in its tests.
  assets: ['replica', 'miniz_oxide', 'libc', 'sim'],
};

const rsFiles = dir => readdirSync(dir, { recursive: true }).filter(f => /\.rs$/.test(f)).map(f => join(dir, f));

/** Rust source with comments and string, char and byte literals blanked (lines kept), so words in them never match. */
export function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/r(#*)"[\s\S]*?"\1/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/b?"(?:\\.|[^"\\])*"/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\\n])'/g, "' '");
}

const FLOAT = /\b(f32|f64)\b|(?<![\w.])\d[\d_]*\.\d[\d_]*(?:[eE][+-]?\d+)?|(?<![\w.])\d[\d_]*[eE][+-]?\d+(?!\w)/;

/** Floats in one file of replica: the type names, and float literals. */
export function floats(file, src) {
  const out = [];
  code(src).split('\n').forEach((line, i) => {
    const m = FLOAT.exec(line);
    if (m) out.push(problem('float-in-replica', `${file}:${i + 1}`, `\`${m[0]}\` in a module not on the allow-list`));
  });
  return out;
}

/** The crates under v2/crates and their dependencies, from `cargo metadata`, against ALLOWED. */
export function dependencies(packages) {
  const out = [];
  for (const p of packages) {
    const allowed = ALLOWED[p.name];
    const deps = p.dependencies.map(d => d.name);
    if (!allowed) {
      out.push(problem('crate-dependency', p.name, `a crate under v2/crates with no allowed list (${deps.join(', ') || 'no dependencies'})`));
      continue;
    }
    for (const d of deps.filter(d => !allowed.includes(d))) {
      out.push(problem('crate-dependency', p.name, `depends on \`${d}\`, which is not on its list`));
    }
  }
  return out;
}

const TODAY = /(?:\.\.\/)+(?:packages|apps|mars|worlds)\/|@souls\//;

/** References from a file under v2/crates to today's packages and content. */
export function today(file, src) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    const m = TODAY.exec(line);
    if (m) out.push(problem('v2-imports-today', `${file}:${i + 1}`, `names \`${m[0]}\``));
  });
  return out;
}

/** T1's test still plants both bad systems and asserts both names. */
export function t1Wired(file, src) {
  const need = ['fn a2_each_planted_bad_system_fails_by_name', '"write-outside-own"', '"read-same-tick"'];
  return need.filter(n => !src.includes(n)).map(n => problem('t1-check-wired', file, `missing ${n}`));
}

function crates() {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--offline'], { cwd: V2, encoding: 'utf8', maxBuffer: 1 << 26 }));
  return meta.packages.filter(p => resolve(p.manifest_path).startsWith(join(V2, 'crates') + '/'));
}

/** Every seeded violation, each with the rule it must fail by. */
async function selfTest() {
  const seeded = join(HERE, 'seeded');
  const read = f => readFileSync(join(seeded, f), 'utf8');
  const { scrubLine } = await import(resolve(REPO, '.github/scripts/guards.mjs'));
  const cases = [
    ['float-in-replica', 'a float in a selector', floats('crates/replica/src/selectors.rs', read('selector.rs'))],
    ['float-in-replica', 'a float in a form rule', floats('crates/replica/src/form_rules.rs', read('form_rule.rs'))],
    ['crate-dependency', 'replica gains a dependency', dependencies(JSON.parse(read('metadata.json')).packages)],
    ['v2-imports-today', 'a v2 crate imports today\'s packages', today('crates/sim/src/ground/legacy.rs', read('imports_today.rs'))],
    ['t1-check-wired', 'T1\'s planted systems removed', t1Wired('crates/replica/tests/zones.rs', 'fn a1_only() {}')],
    ['import from v2/', 'a file outside v2/ imports from it', scrubLine(read('outside_v2.ts').trim(), 'apps/web/src/seeded.ts')],
  ];
  const out = [];
  for (const [rule, what, got] of cases) {
    const hit = got.some(g => g.startsWith(rule));
    console.log(`  seeded: ${what}: ${hit ? got.find(g => g.startsWith(rule)) : 'NOT CAUGHT'}`);
    if (!hit) out.push(`self-test: the seeded violation "${what}" did not fail by ${rule}`);
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const problems = await selfTest();
  const allow = new Set(readFileSync(join(HERE, 'floats.allow'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  const replica = join(V2, 'crates/replica/src');
  for (const f of rsFiles(replica)) {
    const rel = relative(V2, f);
    if (!allow.has(rel)) problems.push(...floats(rel, readFileSync(f, 'utf8')));
  }
  problems.push(...dependencies(crates()));
  for (const f of readdirSync(join(V2, 'crates'), { recursive: true }).filter(f => /\.(rs|toml)$/.test(f))) {
    problems.push(...today(join('crates', f), readFileSync(join(V2, 'crates', f), 'utf8')));
  }
  const zones = join(V2, 'crates/replica/tests/zones.rs');
  problems.push(...t1Wired('crates/replica/tests/zones.rs', existsSync(zones) ? readFileSync(zones, 'utf8') : ''));
  for (const p of problems) console.log(process.env.GITHUB_ACTIONS ? `::error::${p}` : `  ${p}`);
  console.log(`arch: ${Object.keys(RULES).length} rules (and guards.mjs's import from v2/), ${problems.length} problem(s), ${Date.now() - t0} ms`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
