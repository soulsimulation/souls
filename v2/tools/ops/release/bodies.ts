#!/usr/bin/env node
// X2 (0.134): the body files a switched world's page reads, put in the install's page folder without building the new
// page: a prepared body-assets folder (v2/tools/import-body/prepare.mjs) is checked file by file against its pinned
// manifest (`bodyAssetFiles`, the check the new page's build ran) and written to <out>/assets/bodies/<path>, where the
// front door serves /assets/* (proxy/soul-game.caddy). Nothing else is written.
//   node v2/tools/ops/release/bodies.ts --from <prepared body-assets> --out <page folder>
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isMain } from '../../../../tools/lib/is-main.mjs';
import { bodyAssetFiles } from '../../../web/body-assets.ts';

/** Writes the checked body files under `out`/assets/bodies/; the number written. Throws (body.assets-*) on any mismatch. */
export function publishBodies(from: string, out: string): number {
  const files = bodyAssetFiles(from);
  for (const { path, bytes } of files) {
    const file = join(resolve(out), 'assets/bodies', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  return files.length;
}

if (isMain(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const from = opt('--from'), out = opt('--out');
  if (!from || !out) { console.error('usage: bodies.ts --from <prepared body-assets> --out <page folder>'); process.exit(2); }
  console.log(`bodies: ${publishBodies(from, out)} files in ${join(out, 'assets/bodies')}`);
}
