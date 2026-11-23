// W2 (0.133): a world built from a repo template by today's server code, then today's nightly backup.
//   node v2/tools/import-world/template-world.ts <dir> <slug> <template>   (prints the backup's path; then import-world.ts on it)
// The source for a world whose own backup is not at hand: its template, with none of its creator's edits.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Db } from '../../../apps/server/src/db.ts';
import { GodMode, type Genesis } from '../../../apps/server/src/god/god.ts';
const ROOT = resolve(import.meta.dirname, '../../..');
const [dir, slug, template] = process.argv.slice(2);
const data = join(resolve(dir), 'data'), dbFile = join(data, 'worlds', slug, 'sim.db');
mkdirSync(join(data, 'worlds', slug), { recursive: true });
const genesis = JSON.parse(readFileSync(join(ROOT, `worlds/templates/${template}.json`), 'utf8')) as Genesis;
const db = new Db(dbFile);
try { const god = new GodMode(db, { worldId: slug, ownerId: null, tick: () => 1, emit: () => {}, genesis, assetDir: join(data, 'assets') }); console.error(`${slug}: ${god.model.entities.size} things from ${template}`); }
finally { db.close(); }
const out = join(resolve(dir), 'backup');
execFileSync(process.execPath, [join(ROOT, 'tools/world-launcher/deploy/backup.mjs'), data, out], { stdio: 'pipe' });
const day = readdirSync(out).filter((d) => /^\d{8}$/.test(d)).sort().at(-1)!;
console.log(join(out, day, 'worlds', `${slug}.db`));
