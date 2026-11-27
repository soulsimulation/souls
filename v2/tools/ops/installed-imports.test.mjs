// What install.sh bundles runs from where it installs it, not from a checkout: souls-place.service runs
// $LIB/ops/place-created-world.mjs, souls-origin.service $LIB/origin/origin.mjs. This builds the bundle as install.sh
// `check` does (stub programs, a stub page and client), then reads every .mjs in it: each relative import, static or a
// string-literal `import('…')`, must name a file the bundle carries, inside the trees installed side by side under $LIB
// (ops, origin, web, client, templates), and every other import must be a `node:` built-in, since no node_modules is
// installed. Their import of tools/lib/is-main.mjs climbed out of $LIB (to /usr/local/tools/lib), so the installed
// initializer could not load.
//   node --test v2/tools/ops/installed-imports.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

const OPS = import.meta.dirname, REPO = resolve(OPS, '../../..');
/** The bundle's trees that install.sh places side by side under $LIB (install_all's ensure_tree and the client). */
const TREES = ['ops', 'origin', 'web', 'client', 'templates'];

/** install.sh `bundle` into a fresh folder, with a stub of each program, page and served client. → the bundle */
function bundled() {
  const tmp = mkdtempSync(join(tmpdir(), 'installed-imports-'));
  const install = readFileSync(join(OPS, 'install.sh'), 'utf8');
  const programs = install.match(/^PROGRAMS=\(([^)]*)\)/m)[1].trim().split(/\s+/);
  for (const d of ['bins', 'page', 'client']) mkdirSync(join(tmp, d));
  for (const p of programs) writeFileSync(join(tmp, 'bins', p === 'publish-template' ? 'templates' : p), `${p}\n`);
  writeFileSync(join(tmp, 'page/index.html'), '<!doctype html>\n');
  writeFileSync(join(tmp, 'client/soul-client.json'), '{}\n');
  execFileSync('bash', [join(OPS, 'install.sh'), 'bundle', join(tmp, 'b'), join(tmp, 'bins'), join(tmp, 'page'), '', join(tmp, 'client')], { stdio: 'pipe' });
  return { tmp, b: join(tmp, 'b') };
}

function files(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
}

/** Every module specifier a file names: `import … from`, `export … from`, `import '…'` and `import('…')` literals. */
export function specifiers(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const re of [/^\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm, /^\s*import\s*['"]([^'"]+)['"]/gm, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g])
    for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
}

test('specifiers: multi-line, export-from, bare and dynamic imports; comments are not imports', () => {
  const text = "import {\n  a,\n  b,\n} from './a.mjs';\nexport { c } from '../c.mjs';\nimport './d.mjs';\nconst e = await import('./e.mjs');\n// import { f } from './f.mjs';\n/* import g from './g.mjs'; */\n";
  assert.deepEqual(specifiers(text).sort(), ['../c.mjs', './a.mjs', './d.mjs', './e.mjs']);
});

test("every import of every bundled .mjs resolves, where it is installed, to a bundled file or a node: built-in", () => {
  const { tmp, b } = bundled();
  try {
    const mjs = files(b).filter((f) => f.endsWith('.mjs'));
    assert.ok(mjs.some((f) => f.endsWith(`${sep}ops${sep}place-created-world.mjs`)), 'the initializer is bundled');
    assert.ok(mjs.some((f) => f.endsWith(`${sep}origin${sep}origin.mjs`)), 'the origin is bundled');
    const bad = [];
    for (const f of mjs) {
      const at = relative(b, f);
      if (!TREES.includes(at.split(sep)[0])) continue;
      for (const s of specifiers(readFileSync(f, 'utf8'))) {
        if (s.startsWith('node:')) continue;
        if (!s.startsWith('./') && !s.startsWith('../')) { bad.push(`${at}: '${s}' is a package, and no node_modules is installed`); continue; }
        const target = relative(b, resolve(dirname(f), s));
        if (target.startsWith('..') || !TREES.includes(target.split(sep)[0]) || !existsSync(join(b, target))) bad.push(`${at}: '${s}' is not in the installed trees (${target})`);
      }
    }
    assert.deepEqual(bad, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the ops folder's is-main.mjs is tools/lib's, byte for byte", () => {
  assert.equal(readFileSync(join(OPS, 'is-main.mjs'), 'utf8'), readFileSync(join(REPO, 'tools/lib/is-main.mjs'), 'utf8'));
});
