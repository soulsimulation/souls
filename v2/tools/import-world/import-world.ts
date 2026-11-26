// Engine v2 X6 (#2819): the one command. For each backup file given, exports its world's built content (the exporter
// in v2/tools/import-eden/export/export.ts, `--backup`), then loads every facts file into a tree and prints one row per
// world (v2/tools/import-world/src), from the repository root:
//
//   node v2/tools/import-world/import-world.ts <backup.db>… [--world <id>] [--map <map.json>] [--assets <dir>] [--out <dir>] [--json]
//     [--ways [--arrival <x m>,<z m>] [--entries <dir>]]
//
// `--ways` and its `--arrival` and `--entries` go to import-world as given: the one-way floors and seats (W9, #4085).
//
// The export runs under Node's permission model: it may read the content packages, the core asset index, the map and
// the one backup file (and the asset store `--assets` names, read-only), write only its facts file, and has no network, no child processes and no workers. SQLite opens
// the backup read-only and immutable. A backup that does not export is a row that is not clean, with the reason.
import { isMain } from '../../../tools/lib/is-main.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');

/** The export's command line for one backup: node, its permission grants, the exporter and its arguments. */
export function exportArgv(backup: string, out: string, map: string, world = '', assets = ''): string[] {
  const read = ['packages/', 'node_modules/', 'v2/tools/import-eden/export/', 'v2/tools/import-world/export/', 'worlds/core-assets/'].map((p) => join(ROOT, p));
  read.push(resolve(map));
  read.push(resolve(backup));
  if (assets) read.push(`${resolve(assets)}/`);
  return ['--permission', ...read.map((p) => `--allow-fs-read=${p}`), `--allow-fs-write=${dirname(resolve(out))}/`,
    join(ROOT, 'v2/tools/import-eden/export/export.ts'), '--backup', resolve(backup), '--map', resolve(map), '--out', resolve(out), ...(world ? ['--world', world] : []), ...(assets ? ['--assets', resolve(assets)] : [])];
}

/** Exports each backup, then prints the rows. Returns the import-world process's exit status. */
export function run(argv: string[]): number {
  const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
  const flags = new Set(['--world', '--map', '--out', '--assets', '--arrival', '--entries']);
  const backups = argv.filter((a, i) => !a.startsWith('--') && !flags.has(argv[i - 1] ?? ''));
  const map = opt('--map', join(ROOT, 'content/worlds/eden/map.json')), outDir = resolve(opt('--out', join(ROOT, '.local/import-world/out'))), world = opt('--world', ''), assets = opt('--assets', '');
  if (!backups.length) { console.error('usage: import-world.ts <backup.db>… [--world <id>] [--map <map.json>] [--assets <dir>] [--out <dir>] [--json] [--ways [--arrival <x m>,<z m>] [--entries <dir>]]'); return 2; }
  if (!existsSync(map)) console.error(`no map at ${map}: every thing is listed with no entry`);
  mkdirSync(outDir, { recursive: true });
  const facts = backups.map((b, i) => {
    const out = join(outDir, `${i + 1}-${basename(b).replace(/\.[^.]*$/, '')}.facts.json`);
    const r = spawnSync(process.execPath, exportArgv(b, out, map, world, assets), { encoding: 'utf8' });
    if (r.status !== 0) {
      const why = (r.stderr || r.stdout || '').trim().split('\n').filter((l) => /Error|error:/.test(l)).at(-1) ?? `exit ${r.status}`;
      writeFileSync(out, JSON.stringify({ format: 'souls/import-eden/1', world: basename(b), error: why.slice(0, 500) }));
    }
    return out;
  });
  const ways = argv.includes('--ways') ? ['--ways', ...['--arrival', '--entries'].flatMap((k) => (argv.includes(k) ? [k, opt(k, '')] : []))] : [];
  const r = spawnSync('cargo', ['run', '-q', '--release', '--manifest-path', join(ROOT, 'v2/Cargo.toml'), '-p', 'import-world', '--', ...facts, ...(argv.includes('--json') ? ['--json'] : []), ...ways], { stdio: 'inherit' });
  return r.status ?? 1;
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
