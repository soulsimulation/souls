// N-W7 (#3693): every baked model a world draws has a credits entry. Reads the world's baked `models.json` (V17's bake,
// `v2/tools/import-eden/bake/bake.ts`) and the CDN's licence records, prints the uncredited model hashes and exits 1
// when there is any.
//
//   node v2/web/src/credits/check.ts <models.json> [records.json = tools/cdn/approved-derivatives.json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uncredited } from './credits.ts';

const [models, records = fileURLToPath(new URL('../../../../tools/cdn/approved-derivatives.json', import.meta.url))] = process.argv.slice(2);
if (!models) throw new Error('usage: node check.ts <models.json> [records.json]');
const m = JSON.parse(readFileSync(models, 'utf8')), missing = uncredited(m, JSON.parse(readFileSync(records, 'utf8')));
const used = new Set([...Object.values(m.things ?? {}), ...(m.kinds ?? []).map((k: { model?: string | null }) => k.model)].filter(Boolean));
console.log(JSON.stringify({ models: used.size, uncredited: missing.length, missing: missing.slice(0, 20) }));
process.exitCode = missing.length ? 1 : 0;
