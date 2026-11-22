#!/usr/bin/env node
// No document or skill names a deleted path (V3, #4039; the script X14 #2838 and X8 #2839 call for).
//
//   node v2/tools/ci/no-dead-paths.mjs [--list <file>] [--in <folder>]... [--strict]
//
// The delete list is X8's (#2839): the old engine, server, web app, their packages and the old tools. `--list` names
// another, one path a line (`#` starts a comment). The folders read are `docs` and `.claude` (the documents, skills
// and agent definitions), or each `--in` (X8 adds `.github/workflows`); paths are from the repository's root.
//
// It prints each file that names a listed path with its count, then `<n> names in <m> files, <d> of them dead`. A
// name is dead when its listed path is no longer in the tree. It fails (exit 1) on a dead name: while the old tree
// stands the count is a number to bring down (V2, #2838), and once X8 deletes a path every name left of it fails here.
// `--strict` fails on any name, dead or not: X14's "finds no document or skill naming a listed path".
//
// A run starts with a self-test on seeded files, as tools/arch/check.mjs does, so a rule that stopped finding
// anything fails rather than passes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DELETE_LIST = [
  'mars', 'apps/server', 'apps/web',
  'packages/engine-mars', 'packages/engine-contract', 'packages/engine-toy', 'packages/engine-native',
  'packages/kernel', 'packages/protocol', 'packages/client', 'packages/brain', 'packages/conformance',
  'tools/world-launcher', 'tools/edge-skill', 'tools/god-skill', 'tools/world-skill',
];
/** Under a listed path, but kept (X8's keep list): today's shape code, which V8's and V17's tools run. */
export const KEEP = ['apps/web/src/gen-mesh'];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Where `text` names `path` as a path from the repository's root: not inside a longer path or word (`v2/web`,
 * `soul.game/w/mars/`), and ending there or going on below it. A one-word path (`mars`) counts only with its slash.
 */
export function names(text, path, keep = KEEP) {
  const end = path.includes('/') ? '(?![\\w-])' : '(?=/)';
  const re = new RegExp(`(?<![\\w./@-])${escape(path)}${end}`, 'g');
  const out = [];
  for (const m of text.matchAll(re)) {
    if (!keep.some((k) => text.startsWith(k, m.index))) out.push(m.index);
  }
  return out;
}

function files(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'worktrees') files(p, out); }
    else if (e.isFile() && statSync(p).size < 2_000_000) out.push(p);
  }
  return out;
}

/** Every file under `folders` (from `root`) naming a path on `list`: `{file, path, count, dead}` rows. */
export function check(root, folders, list, keep = KEEP) {
  const rows = [];
  for (const folder of folders) {
    if (!existsSync(join(root, folder))) continue;
    for (const file of files(join(root, folder))) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('\0')) continue; // not text
      for (const path of list) {
        const count = names(text, path, keep).length;
        if (count) rows.push({ file: relative(root, file), path, count, dead: !existsSync(join(root, path)) });
      }
    }
  }
  return rows;
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'no-dead-paths-'));
  try {
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'apps/web/src/gen-mesh'), { recursive: true });
    writeFileSync(join(root, 'docs/a.md'), 'Run `node tools/god-skill/dev-world.mjs`, then open apps/web/dist. See mars/AGENTS.md.\n');
    writeFileSync(join(root, 'docs/b.md'), 'v2/web is the page; apps/web/src/gen-mesh is kept; soul.game/w/mars/ is a world; packages/client-kit is not listed.\n');
    const rows = check(root, ['docs'], DELETE_LIST);
    const got = rows.map((r) => `${r.file} ${r.path} ${r.count} ${r.dead}`).sort().join('\n');
    const want = ['docs/a.md apps/web 1 false', 'docs/a.md mars 1 true', 'docs/a.md tools/god-skill 1 true'].join('\n');
    if (got !== want) throw new Error(`no-dead-paths: the self-test found\n${got}\nnot\n${want}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), folders = [];
  let list = DELETE_LIST, strict = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict') strict = true;
    else if (args[i] === '--in' && args[i + 1]) folders.push(args[++i]);
    else if (args[i] === '--list' && args[i + 1]) list = readFileSync(args[++i], 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim().replace(/\/+$/, '')).filter(Boolean);
    else { console.error('usage: node v2/tools/ci/no-dead-paths.mjs [--list <file>] [--in <folder>]... [--strict]'); process.exit(2); }
  }
  selfTest();
  const root = resolve(fileURLToPath(import.meta.url), '../../../..');
  const rows = check(root, folders.length ? folders : ['docs', '.claude'], list);
  const byFile = new Map();
  for (const r of rows) {
    const f = byFile.get(r.file) ?? byFile.set(r.file, { count: 0, dead: 0, paths: [] }).get(r.file);
    f.count += r.count; f.paths.push(r.dead ? `${r.path} (dead)` : r.path);
    if (r.dead) f.dead += r.count;
  }
  for (const [file, f] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) console.log(`${file}: ${f.count} (${f.paths.join(', ')})`);
  const total = rows.reduce((n, r) => n + r.count, 0), dead = rows.reduce((n, r) => n + (r.dead ? r.count : 0), 0);
  console.log(`no-dead-paths: ${total} names in ${byFile.size} files, ${dead} of them dead`);
  process.exit(dead || (strict && total) ? 1 : 0);
}
