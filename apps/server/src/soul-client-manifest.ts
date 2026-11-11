// What a world says about the Soul CLI it serves, read with /v1/config: a Souls home records it and checks a world's needs
// against it, and `upgrade` verifies the bundle it fetches. Computed from the served file, once per change of that file.
// The skill served beside it carries the same version (#1875) and is described the same way, so `upgrade` refreshes both.
import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {EDGE_CONTRACT} from './edge/contract.ts';

/** The oldest CLI this server's edge contract still serves. Raise it only when an older client would misread the world. */
export const SOUL_CLIENT_MIN = '2.0.0';
export type SoulSkillManifest = {version: string; bytes: number; sha256: string};
export type SoulClientManifest = {contract: string; version: string; bytes: number; sha256: string; minVersion: string; skill?: SoulSkillManifest};
type Held<T> = {file: string; mtimeMs: number; size: number; value: T | undefined};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function described<T>(file: string | undefined, held: {last: Held<T> | null}, make: (bytes: Buffer) => T | undefined): T | undefined {
  if (!file) return undefined;
  try {
    const {mtimeMs, size} = statSync(file);
    if (held.last?.file === file && held.last.mtimeMs === mtimeMs && held.last.size === size) return held.last.value;
    const value = make(readFileSync(file));
    held.last = {file, mtimeMs, size, value};
    return value;
  } catch { return undefined; }
}
const cli: {last: Held<Omit<SoulClientManifest, 'skill'>> | null} = {last: null}, skill: {last: Held<SoulSkillManifest> | null} = {last: null};
/** The served skill's frontmatter version; a skill that names none is not described, so `upgrade` leaves skills alone. */
export function soulSkillManifest(file: string | undefined): SoulSkillManifest | undefined {
  return described(file, skill, bytes => {
    const version = /^\s*version:\s*"?([0-9][0-9.]*)"?\s*$/m.exec(bytes.toString('utf8'))?.[1];
    return version ? {version, bytes: bytes.length, sha256: sha(bytes)} : undefined;
  });
}
export function soulClientManifest(file: string | undefined, skillFile?: string): SoulClientManifest | undefined {
  const manifest = described(file, cli, bytes => {
    const version = /const VERSION = "([0-9.]+)"/.exec(bytes.toString('utf8'))?.[1];
    return version ? {contract: EDGE_CONTRACT, version, bytes: bytes.length, sha256: sha(bytes), minVersion: SOUL_CLIENT_MIN} : undefined;
  });
  const s = manifest && soulSkillManifest(skillFile);
  return manifest && (s ? {...manifest, skill: s} : manifest);
}
