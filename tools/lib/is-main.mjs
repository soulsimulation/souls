// Whether a module is the script node was started with: `if (isMain(import.meta.url)) …`.
// Node gives a module its real path (import.meta.url) but leaves process.argv[1] as typed, so comparing the two
// directly is false when the script is started through a symlink (production runs from /srv/sim-worlds/production,
// a link to the live release): such a script exited 0 without running. Both sides are compared as real paths.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @param {string} url the module's import.meta.url */
export function isMain(url) {
  const started = process.argv[1];
  if (!started) return false;
  try { return realpathSync(started) === realpathSync(fileURLToPath(url)); }
  catch { return false; }   // argv[1] is not a file (node -e with arguments): not this module
}
