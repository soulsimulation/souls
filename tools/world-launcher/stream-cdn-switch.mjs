#!/usr/bin/env node
// #4159: turn a world's live stream on the CDN on or off, in the cutover binding the launcher reads again within a second
// (cutover.mjs cutoverFence): `on` sets the world's `v2StreamOrigin` to https://stream.soul.game, `off` removes it. Pages
// loaded after that read the stream from the CDN (on) or from soul.game's own /s/ (off); open pages keep what they had
// until they reload. The previous file is kept beside it as `<file>.bak.<ms>`; the new one keeps its owner and mode.
//   sudo node tools/world-launcher/stream-cdn-switch.mjs [--binding /etc/souls/cutover-binding.json] <slug> on|off
// Prints the world's entry after the change. Refuses a slug the binding does not name.
import { chownSync, copyFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { cutoverFence } from './cutover.mjs';

export const STREAM_CDN = 'https://stream.soul.game';

/** The binding with `slug`'s `v2StreamOrigin` set (`on`) or removed; throws when no world in it is `slug`. */
export function switched(binding, slug, on) {
  let found = false;
  const set = (w) => {
    if (w.canonicalSlug !== slug) return w;
    found = true;
    const { v2StreamOrigin, ...rest } = w;
    return on ? { ...rest, v2StreamOrigin: STREAM_CDN } : rest;
  };
  const out = Array.isArray(binding.worlds) ? { ...binding, worlds: binding.worlds.map(set) } : set(binding);
  if (!found) throw Error(`no world ${slug} in the binding`);
  cutoverFence({ binding: out }); // the launcher's own check: an invalid result is never written
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2), i = argv.indexOf('--binding');
  const file = i < 0 ? '/etc/souls/cutover-binding.json' : argv.splice(i, 2)[1];
  const [slug, mode] = argv;
  if (!slug || !['on', 'off'].includes(mode)) { console.error('usage: stream-cdn-switch.mjs [--binding <file>] <slug> on|off'); process.exit(2); }
  const out = switched(JSON.parse(readFileSync(file, 'utf8')), slug, mode === 'on');
  const st = statSync(file);
  copyFileSync(file, `${file}.bak.${Date.now()}`);
  writeFileSync(`${file}.new`, JSON.stringify(out, null, 1) + '\n', { mode: st.mode & 0o777 });
  try { chownSync(`${file}.new`, st.uid, st.gid); } catch { /* not root: the file is this user's, as before */ }
  renameSync(`${file}.new`, file);
  console.log(JSON.stringify((out.worlds ?? [out]).find((w) => w.canonicalSlug === slug)));
}
