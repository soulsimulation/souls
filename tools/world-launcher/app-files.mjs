// #4986: the web build's own files, as a set that can be copied to the asset CDN whole. The built code names its files
// by where it was loaded from (apps/web/vite.config.ts builtUrl), so a page told to load its code from the CDN asks the
// CDN for every file in the build's `assets/` folder it comes to need: scripts, styles, data, images, sounds. The page is
// told so only when the CDN holds them all (cutover.mjs `appCdn`), and "all" is this list: every file in `<webDir>/assets`
// (not the `.br`/`.gz` copies the release makes beside them), by name, size and sha256. `set` names the list: sha256 over
// its sorted `name sha256` lines, 32 hex. tools/cdn/mirror-first-load.mjs reads the list at `/__sim/app-files.json`, copies
// each file and then writes the set's marker; the launcher looks for that marker.
// A folder holding anything a copy could not serve by name (a subfolder, a name without a content hash) has no set: such a
// build stays on the origin rather than load half of itself from each place.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const APP_FILES = 'souls/app-files/1';
/** A build file's name: Vite's `<name>-<8 char hash>.<ext>` (or the icon plugin's 10 hex), of a type a browser is served. */
export const APP_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}-[A-Za-z0-9_-]{8,10}\.(?:js|css|json|wasm|png|jpg|jpeg|webp|avif|svg|mp3|mp4|woff2)$/;
const COPY = /\.(?:br|gz)$/;
const MAX_FILE = 64 * 1024 * 1024, MAX_FILES = 2000;

/** The set id of a list of `{ name, sha256 }`. */
export const setOf = (files) => createHash('sha256').update([...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((f) => `${f.name} ${f.sha256}\n`).join('')).digest('hex').slice(0, 32);

/** `<webDir>/assets` as `{ schema, set, files: [{ name, bytes, sha256 }] }` sorted by name, or `{ problem }`: why it
 *  has no set (missing, empty, or the first entry that cannot be copied by name). */
export function scanAppFiles(webDir) {
  const dir = join(webDir, 'assets');
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { problem: 'the web build has no assets folder' }; }
  const files = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isFile() && COPY.test(e.name) && APP_FILE.test(e.name.replace(COPY, ''))) continue;   // the release's precompressed copy of a listed file
    if (!e.isFile() || !APP_FILE.test(e.name)) return { problem: `assets/${e.name.slice(0, 80)} is not a file with a content hash in its name` };
    const body = readFileSync(join(dir, e.name));
    if (body.length > MAX_FILE || files.length >= MAX_FILES) return { problem: `assets/${e.name.slice(0, 80)}: too large, or too many files` };
    files.push({ name: e.name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  }
  return files.length ? { schema: APP_FILES, set: setOf(files), files } : { problem: 'the web build\'s assets folder is empty' };
}
/** `scanAppFiles(webDir)`, or null when the folder has no set. */
export function listAppFiles(webDir) { const scan = scanAppFiles(webDir); return scan.problem ? null : scan; }

/** `listAppFiles(webDir)`, read again only when the folder changes (a release is a new folder; a rebuild in place
 *  rewrites it). `.problem()` says why the folder read last has no set (null when it has one). */
export function appFiles(webDir) {
  let key = null, held = null, problem = null;
  const read = () => {
    let st; try { st = statSync(join(webDir, 'assets')); } catch { key = null; problem = 'the web build has no assets folder'; return (held = null); }
    const now = `${st.ino}:${st.mtimeMs}`;
    if (now !== key) {
      key = now;
      let scan; try { scan = scanAppFiles(webDir); } catch (e) { scan = { problem: `cannot be read (${e?.code ?? 'error'})` }; }
      problem = scan.problem ?? null; held = scan.problem ? null : scan;
    }
    return held;
  };
  return Object.assign(read, { problem: () => (read(), problem) });
}
