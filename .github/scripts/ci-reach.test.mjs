import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReach, globRe, mentions, pathPart, unplaceable } from './ci-reach.mjs';

// A small tree: a shared package, a server that imports it, tests, content read by a computed path, scripts.
const TREE = {
  'packages/kern/package.json': '{"name":"@x/kern","exports":{".":"./src/index.ts"}}',
  'packages/kern/src/index.ts': "export * from './rules.ts';",
  'packages/kern/src/rules.ts': 'export const rule = 1;',
  'packages/kern/src/rules.test.ts': "import { rule } from './rules.ts';",
  'packages/kern/cases/a.json': '{"case":1}',
  'apps/server/package.json': '{"name":"@x/server"}',
  'apps/server/src/world.ts': "import { rule } from '@x/kern';\nimport { join } from 'node:path';\nconst moves = join(ROOT, 'content', 'moves');",
  'apps/server/src/world.test.ts': "import { world } from './world.ts';",
  'apps/server/src/http.ts': "export const page = await import('./page.ts');",
  'apps/server/src/page.ts': 'export const p = 1;',
  'apps/server/src/http.test.ts': "import './http.ts';",
  'apps/server/src/alone.test.ts': "const mode = ['content', 'edge'];",
  'apps/server/src/fixtures/x.json': '{}',
  'content/moves/pour.json': '{"move":"pour"}',
  'tools/cli/run.mjs': "import { spawn } from 'node:child_process';\nspawn(process.execPath, [new URL('./step.mjs', import.meta.url).pathname]);",
  'tools/cli/step.mjs': 'console.log(1);',
  'tools/cli/run.test.mjs': "import './run.mjs';",
  'tools/kit/a/upload.mjs': '', 'tools/kit/b/upload.mjs': '',
  'tools/reader/reader.mjs': "import { readFileSync } from 'node:fs';\nconst KIT = 'tools/kit/a';\nreadFileSync(KIT + '/' + 'upload.mjs');",
  'tools/reader/reader.test.mjs': "import './reader.mjs';",
  'docs/a.md': 'See apps/server/src/world.ts.',
};
const map = (tree = TREE, extra = []) => buildReach({ files: Object.keys(tree), extra, read: f => tree[f] ?? null });
const hit = (changed, tree, extra) => [...map(tree, extra).affected(changed).behaviour].filter(f => /\.test\./.test(f)).sort();

test('a test that imports X is affected when X changes, through re-exports and a package import', () => {
  assert.deepEqual(hit(['packages/kern/src/rules.ts']), ['apps/server/src/world.test.ts', 'packages/kern/src/rules.test.ts']);
  assert.deepEqual(hit(['apps/server/src/world.ts']), ['apps/server/src/world.test.ts']);
  assert.deepEqual(hit(['apps/server/src/page.ts']), ['apps/server/src/http.test.ts'], 'import() of a literal');
});

test('a change in a shared package selects its importers, and a package test does not', () => {
  assert.ok(hit(['packages/kern/src/index.ts']).includes('apps/server/src/world.test.ts'));
  assert.deepEqual(hit(['packages/kern/src/rules.test.ts']), ['packages/kern/src/rules.test.ts']);
});

test('content read by a computed path: join() literals name the folder; a bare word alone names nothing', () => {
  assert.deepEqual(hit(['content/moves/pour.json']), ['apps/server/src/world.test.ts']);
  assert.ok(!hit(['content/moves/pour.json']).includes('apps/server/src/alone.test.ts'));
});

test('data of a unit reaches every code file of that unit', () => {
  assert.ok(hit(['packages/kern/cases/a.json']).includes('packages/kern/src/rules.test.ts'));
  assert.ok(hit(['apps/server/src/fixtures/x.json']).includes('apps/server/src/alone.test.ts'));
  assert.ok(!hit(['apps/server/src/fixtures/x.json']).includes('packages/kern/src/rules.test.ts'));
});

test('a loader that names a script runs it: the script changing affects the loader\'s tests', () => {
  assert.deepEqual(hit(['tools/cli/step.mjs']), ['tools/cli/run.test.mjs']);
});

test('a bare file name picks the candidate under a folder the file names, not every file so named', () => {
  assert.deepEqual(hit(['tools/kit/a/upload.mjs']), ['tools/reader/reader.test.mjs']);
  assert.deepEqual(hit(['tools/kit/b/upload.mjs']), []);
});

test('a deleted file still reaches its importers', () => {
  const tree = { ...TREE };
  delete tree['apps/server/src/page.ts'];
  assert.deepEqual(hit(['apps/server/src/page.ts'], tree, ['apps/server/src/page.ts']), ['apps/server/src/http.test.ts']);
});

test('a file the map cannot place is unplaceable: the caller runs the full battery', () => {
  for (const f of ['pnpm-lock.yaml', 'package.json', 'apps/server/package.json', 'apps/web/tsconfig.json', 'apps/web/vite.config.ts', '.github/workflows/ci.yml',
    'vendor/x.js', 'tools/x/.env.example', 'tools/test-harness/walk/baseline/eden-2026.json', 'tools/test-harness/bundle-budget/baseline.json',
    'tools/x/thing.weird', 'LICENSE', 'deploy.env.example', '.gitleaks.toml'])
    assert.ok(unplaceable(f), f);
  for (const f of ['apps/server/src/world.ts', 'content/moves/pour.json', 'docs/testing.md', 'README.md', 'tools/x/a.sh', 'mars/viewer/a.png', 'changes/x.md'])
    assert.equal(unplaceable(f), null, f);
});

test('mentions: literals with a folder or an extension, join() arguments put together, template pieces', () => {
  const m = [...mentions("join(ROOT, 'content', 'kinds'); x = ['mars', 'edge']; y = `${R}/docs`; new URL('../a.mjs', import.meta.url)", true)];
  for (const s of ['./content/kinds', './docs', '../a.mjs']) assert.ok(m.includes(s), s);
  assert.ok(!m.includes('mars') && !m.includes('edge'));
  const routes = [...mentions("route('/docs'); read(ROOT + '/content/kinds')", true)];
  assert.ok(!routes.includes('/docs') && !routes.includes('./docs') && routes.includes('./content/kinds'), routes.join());
  assert.equal(pathPart('tools/god-skill/*.test.mjs'), 'tools/god-skill');
  assert.equal(pathPart('https://example.com/a'), null);
  assert.ok(globRe('apps/server/src/**/*.test.ts').test('apps/server/src/god/a.test.ts'));
  assert.ok(globRe('apps/web/').test('apps/web/public/x.png'));
  assert.ok(!globRe('tools/x/*.test.mjs').test('tools/x/y/a.test.mjs'));
});
