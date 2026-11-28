#!/usr/bin/env node
// #4159: turn a world's live stream on the CDN on or off, in the cutover binding the launcher reads again within a second
// (cutover.mjs cutoverFence): `on` sets the world's `v2StreamOrigin` to https://stream.soul.game, `off` removes it. Pages
// loaded after that read the stream from the CDN (on) or from soul.game's own /s/ (off); open pages keep what they had
// until they reload. The previous file is kept beside it as `<file>.bak.<ms>`; the new one keeps its owner and mode.
//   sudo node tools/world-launcher/stream-cdn-switch.mjs [--binding /etc/souls/cutover-binding.json] <slug> on|off
// Prints the world's entry after the change. Refuses a slug the binding does not name.
// #4986: with `--first-load` it switches the world's `firstLoadOrigin` (https://cdn.soul.game) instead: the asset CDN the
// launcher looks on for copies of the replica it serves and of the web build's own files, and names each to the page
// (`v2ReplicaCdn`, `appCdn`) once it has seen it there (cutover.mjs edgeLook).
//   sudo node tools/world-launcher/stream-cdn-switch.mjs --first-load <slug> on|off
import { chownSync, copyFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { cutoverFence } from './cutover.mjs';
import { isMain } from '../lib/is-main.mjs';

export const STREAM_CDN = 'https://stream.soul.game';
export const FIRST_LOAD_CDN = 'https://cdn.soul.game';
const FIELDS = { v2StreamOrigin: STREAM_CDN, firstLoadOrigin: FIRST_LOAD_CDN };

/** The binding with `slug`'s `v2StreamOrigin` (or, #4986, the other `field` of FIELDS) set (`on`) or removed; throws
 *  when no world in it is `slug`. */
export function switched(binding, slug, on, field = 'v2StreamOrigin') {
  if (!Object.hasOwn(FIELDS, field)) throw Error(`no switch for ${field}`);
  let found = false;
  const set = (w) => {
    if (w.canonicalSlug !== slug) return w;
    found = true;
    const { [field]: _, ...rest } = w;
    return on ? { ...rest, [field]: FIELDS[field] } : rest;
  };
  const out = Array.isArray(binding.worlds) ? { ...binding, worlds: binding.worlds.map(set) } : set(binding);
  if (!found) throw Error(`no world ${slug} in the binding`);
  cutoverFence({ binding: out }); // the launcher's own check: an invalid result is never written
  return out;
}

if (isMain(import.meta.url)) { // production runs it through /srv/sim-worlds/production, a link to the live release
  const argv = process.argv.slice(2), i = argv.indexOf('--binding');
  const file = i < 0 ? '/etc/souls/cutover-binding.json' : argv.splice(i, 2)[1];
  const f = argv.indexOf('--first-load'), field = f < 0 ? 'v2StreamOrigin' : (argv.splice(f, 1), 'firstLoadOrigin');
  const [slug, mode] = argv;
  if (!slug || !['on', 'off'].includes(mode)) { console.error('usage: stream-cdn-switch.mjs [--binding <file>] [--first-load] <slug> on|off'); process.exit(2); }
  const out = switched(JSON.parse(readFileSync(file, 'utf8')), slug, mode === 'on', field);
  const st = statSync(file);
  copyFileSync(file, `${file}.bak.${Date.now()}`);
  writeFileSync(`${file}.new`, JSON.stringify(out, null, 1) + '\n', { mode: st.mode & 0o777 });
  try { chownSync(`${file}.new`, st.uid, st.gid); } catch { /* not root: the file is this user's, as before */ }
  renameSync(`${file}.new`, file);
  console.log(JSON.stringify((out.worlds ?? [out]).find((w) => w.canonicalSlug === slug)));
}
