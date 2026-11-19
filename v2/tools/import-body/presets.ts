// Today's body presets (`body set <preset>`) imported through B13's importer (Engine v2 B15b, #2750), so a v2 world
// admits them and a Soul can `wear` one: the Little Martians' floaters from their body files (pulled media,
// `worlds/littlemartians/characters/`) and the authored creatures, Pip, the monster, the ghost and the centaur (their
// authoring kits; all but the ghost start from the pulled `animated-casual.glb`). Each is written by `import-body.ts`'s
// `write` under --out, and the catalogue `bodies.json` (`souls/bodies/1`, `skills::wear`) lists every one admitted:
// its preset id, content hash (the SHA-256 of its kind file), size class, height, hover and crowd entry. A world reads
// the catalogue from its folder (`worldd seed --bodies`); the page from its bodies directory, beside the entries.
//
// Not here: today's procedural creatures (duck, snail, dog), which have no body file to import, and the default
// humanoid, which is the world's default body (no hash). A preset refused by the importer is printed and left out.
//
//   node v2/tools/import-body/presets.ts --out <dir> [--media <checkout with pulled media>]   (from the repository root)
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FLOATER_MODELS } from '../../../mars/viewer/engine/bodies/models.ts';
import { authorCentaur } from '../../../tools/body-authoring/centaur/author.mjs';
import { authorGhost } from '../../../tools/body-authoring/ghost/author.mjs';
import { authorMonster } from '../../../tools/body-authoring/monster/author.mjs';
import { authorPip } from '../../../tools/body-authoring/robot/author.mjs';
import { importBody, Refused, write } from './import-body.ts';

const REPO = resolve(import.meta.dirname, '../../..');

/** One catalogue entry, as `skills::wear::Catalogue` reads it, with the page's crowd entry. */
export type Entry = { preset: string; hash: string; size: string; height: number; hover: number; entry: string };

/** Each preset's body file and manifest, written to `tmp`: [preset id, glb path, manifest path], or why not. */
export function sources(media: string, tmp: string): ([string, string, string] | [string, null, string])[] {
  const out: ([string, string, string] | [string, null, string])[] = [];
  const motion = JSON.parse(readFileSync(join(REPO, 'tools/body-authoring/example.json'), 'utf8')).motion;
  for (const m of FLOATER_MODELS) {
    const glb = join(media, 'worlds/littlemartians/characters', m.file);
    if (!existsSync(glb)) {
      out.push([m.id, null, `${glb} is not pulled`]);
      continue;
    }
    const manifest = join(tmp, `${m.id}.json`);
    const kind = { type: 'ceramic', license: 'owned', rightsConfirmed: true, name: m.name, description: `${m.name}, a Little Martian.`, motion };
    writeFileSync(manifest, JSON.stringify(kind));
    out.push([m.id, glb, manifest]);
  }
  const casual = join(media, 'mars/viewer/public/modular/environment/animated-casual.glb');
  const authored: [string, () => { bytes: Uint8Array; manifest: object }][] = [
    ['pip', () => authorPip({ source: casual })],
    ['monster', () => authorMonster({ source: casual })],
    ['ghost', () => authorGhost()],
    ['centaur', () => authorCentaur({ source: casual })],
  ];
  for (const [id, author] of authored) {
    try {
      const a = author();
      const glb = join(tmp, `${id}.glb`), manifest = join(tmp, `${id}.manifest.json`);
      writeFileSync(glb, a.bytes);
      writeFileSync(manifest, JSON.stringify(a.manifest));
      out.push([id, glb, manifest]);
    } catch (e) {
      out.push([id, null, String((e as Error)?.message ?? e)]);
    }
  }
  return out;
}

/** Imports every preset under `out` and writes `bodies.json`; returns the entries and the presets left out. */
export async function importPresets(out: string, media = REPO) {
  const tmp = mkdtempSync(join(tmpdir(), 'presets-'));
  const bodies: Entry[] = [], left: { preset: string; why: string }[] = [];
  try {
    for (const [preset, glb, manifest] of sources(media, tmp)) {
      if (glb === null) {
        left.push({ preset, why: manifest });
        continue;
      }
      try {
        const b = await importBody(glb, manifest);
        const w = write(b, out);
        bodies.push({
          preset, hash: createHash('sha256').update(b.text).digest('hex'), size: b.size, height: b.heightMm, hover: b.hoverMm,
          entry: w.file.replace(/\.diag$/, '.json'),
        });
      } catch (e) {
        left.push({ preset, why: e instanceof Refused ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e) });
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(join(out, 'bodies.json'), JSON.stringify({ format: 'souls/bodies/1', bodies }, null, 1) + '\n');
  return { bodies, left };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const a = process.argv.slice(2), at = (k: string) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : undefined);
  const out = at('--out');
  if (!out) {
    console.error('usage: node v2/tools/import-body/presets.ts --out <dir> [--media <checkout with pulled media>]');
    process.exit(2);
  }
  importPresets(resolve(out), resolve(at('--media') ?? REPO)).then((r) => console.log(JSON.stringify({ imported: r.bodies.map((b) => b.preset), left: r.left }, null, 1)));
}
