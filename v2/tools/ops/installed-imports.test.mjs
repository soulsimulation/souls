// The ops scripts install.sh bundles run from $LIB/ops (place-created-world.mjs is souls-place.service's ExecStart),
// not from a checkout: every relative import they make must resolve there to a file the bundle carries. Their import
// of tools/lib/is-main.mjs climbed out of $LIB (to /usr/local/tools/lib), so the installed initializer could not load.
//   node --test v2/tools/ops/installed-imports.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const OPS = import.meta.dirname, REPO = resolve(OPS, '../../..'), LIB = '/usr/local/lib/souls';
const install = readFileSync(join(OPS, 'install.sh'), 'utf8');
/** The bundle's files, as install.sh's `bundle` and `origin_files` copy them: repository path → installed path. */
const bundled = new Map([
  ...['place-created-world.mjs', 'archive-world.mjs', 'place-world.sh', 'world-limits.mjs', 'is-main.mjs'].map((f) => [join(OPS, f), `${LIB}/ops/${f}`]),
  ...['route-config.mjs', 'routes.mjs'].map((f) => [join(OPS, 'proxy', f), `${LIB}/ops/proxy/${f}`]),
  ...['origin.mjs', 'cache.mjs', 'site.mjs', 'ops.mjs', 'owner-auth.mjs', 'world-routes.mjs', 'upgrade-refusal.mjs', 'agents.mjs'].map((f) => [join(REPO, 'v2/tools/origin', f), `${LIB}/origin/${f}`]),
]);

test('install.sh bundles every file this test takes as bundled', () => {
  for (const repo of bundled.keys()) {
    const rel = relative(OPS, repo);
    const name = rel.startsWith('..') ? `$HERE/../origin/${relative(join(REPO, 'v2/tools/origin'), repo)}` : `$HERE/${rel}`;
    assert.ok(install.includes(`"${name}"`), `install.sh copies ${name}`);
  }
});

test('every relative import of a bundled script resolves, where it is installed, to a bundled file', () => {
  const installedAt = new Map([...bundled].map(([repo, lib]) => [lib, repo]));
  for (const [repo, lib] of bundled) {
    if (!repo.endsWith('.mjs')) continue;
    for (const [, spec] of readFileSync(repo, 'utf8').matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const there = resolve(dirname(lib), spec);
      assert.ok(installedAt.has(there), `${relative(REPO, repo)} imports ${spec}: ${there} is not installed`);
      assert.equal(installedAt.get(there), resolve(dirname(repo), spec), `${relative(REPO, repo)} imports ${spec}: another file there`);
    }
  }
});

test("the ops folder's is-main.mjs is tools/lib's, byte for byte", () => {
  assert.equal(readFileSync(join(OPS, 'is-main.mjs'), 'utf8'), readFileSync(join(REPO, 'tools/lib/is-main.mjs'), 'utf8'));
});
