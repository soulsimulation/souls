// V5 (#2714) A4: nothing under v2/web imports from today's app or packages (apps/, packages/, or a workspace package
// by name), by any import, export-from, dynamic import, worker URL or require.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(web, '../..');
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|new\s+URL\s*\(\s*)['"]([^'"]+)['"]/g;

/** The specifiers in `text` that reach apps/ or packages/ from `file`. */
export function forbidden(file: string, text: string): string[] {
  const out: string[] = [];
  for (const [, spec] of text.matchAll(SPEC)) {
    const bad = spec.startsWith('.') || spec.startsWith('/')
      ? /^(apps|packages)(\/|$)/.test(relative(repo, resolve(dirname(file), spec)))
      : /^@souls\//.test(spec) || /(^|\/)(apps|packages)\//.test(spec);
    if (bad) out.push(spec);
  }
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n === 'dist') return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(m?[jt]s|tsx?|html|json)$/.test(n) ? [p] : [];
  });
}

test('the check finds seeded imports from apps/ and packages/', () => {
  const f = join(web, 'src/draw/x.ts');
  assert.deepEqual(forbidden(f, `import a from '../../../../apps/web/src/quality-tier.ts';`), ['../../../../apps/web/src/quality-tier.ts']);
  assert.deepEqual(forbidden(f, `export { b } from "../../../../packages/client/src/hello.ts"`), ['../../../../packages/client/src/hello.ts']);
  assert.deepEqual(forbidden(f, `const m = await import('@souls/camera');`), ['@souls/camera']);
  assert.deepEqual(forbidden(f, `import * as THREE from 'three'; import { x } from './y.ts';`), []);
});

test('nothing under v2/web imports from apps/ or packages/', () => {
  const all = files(web).filter((f) => f !== fileURLToPath(import.meta.url)); // its own seeded lines aside
  assert.ok(all.length >= 8, `only ${all.length} files read`);
  const found = all.flatMap((f) => forbidden(f, readFileSync(f, 'utf8')).map((s) => `${relative(web, f)}: ${s}`));
  assert.deepEqual(found, []);
});
