// The served client's loader (Engine v2 R17, #2818): the tail of eden.mjs. build.mjs writes VERSION, ENTRY (the thin
// command's path) and FILES (the client's modules by repo-relative path) above it; not run on its own.
//
// - The home is SOULS_HOME, else the nearest .souls upward from here to the user's home folder, else ./.souls.
// - A copy that is not the home's `.souls/bin/eden.mjs` hands off to that one, its arguments unchanged, unless this
//   copy is newer (docs/architecture/api.md, "Soul client upgrade", frozen).
// - The modules are unpacked once into `.souls/bin/client/<version>-<digest>/` and the thin command runs from there,
//   so its daemon and its pairing start from files, as they do in the repository.
// - `pair <world url>` in a home with no client first installs it (`../src/upgrade/served.mjs`): the world's address
//   becomes the home's one trusted site, and the client, the skill and the daemon's library are fetched from it, each
//   checked by length and hash before anything is written. A command whose version has no library yet fetches it.
// - `upgrade`: a newer client from that site (served.mjs), then R18's `main` (`../src/upgrade/upgrade.mjs`), which
//   brings the home's Souls of today's client across; `upgrade --rollback`: R18's `main`, then the daemons hand over.
// - `version` prints the version.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const say = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

function findHome() {
  if (process.env.SOULS_HOME) return resolve(process.env.SOULS_HOME);
  const start = real(process.cwd()), stop = real(homedir());
  for (let dir = start; ; dir = dirname(dir)) {
    const h = join(dir, '.souls');
    if (existsSync(join(h, 'config.json')) || existsSync(join(h, 'souls'))) return h;
    if (dir === stop || dirname(dir) === dir) return join(start, '.souls');
  }
}

const num = (v) => v.split('.').map(Number);
const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const versionIn = (file) => { try { return /^const VERSION = "(\d+\.\d+\.\d+)";$/m.exec(readFileSync(file, 'utf8'))?.[1]; } catch { return undefined; } };

const args = process.argv.slice(2);
const home = findHome();
const installed = join(home, 'bin', 'eden.mjs');
const self = fileURLToPath(import.meta.url);

const theirs = real(self) !== real(installed) && versionIn(installed);
if (theirs && !newer(VERSION, theirs)) {
  const r = spawnSync(process.execPath, [installed, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

// Unpacked once per version; a half-written folder is never used.
const digest = createHash('sha256').update(JSON.stringify(FILES)).digest('hex').slice(0, 16);
const root = join(home, 'bin', 'client', `${VERSION}-${digest}`);
if (!existsSync(join(root, '.whole'))) {
  const tmp = `${root}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  for (const [f, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(tmp, f)), { recursive: true, mode: 0o700 });
    writeFileSync(join(tmp, f), text);
  }
  writeFileSync(join(tmp, '.whole'), '');
  rmSync(root, { recursive: true, force: true });
  try { renameSync(tmp, root); } catch (e) { rmSync(tmp, { recursive: true, force: true }); if (!existsSync(join(root, '.whole'))) throw e; }
}

const served = () => import(pathToFileURL(join(root, 'v2/client/src/upgrade/served.mjs')).href);
const crossing = () => import(pathToFileURL(join(root, 'v2/client/src/upgrade/upgrade.mjs')).href);
const refused = (e) => { say({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 300) }); process.exitCode = 1; };
const env = { ...process.env, SOULS_HOME: home };

if (args[0] === 'version') say({ ok: true, version: VERSION });
else if (args[0] === 'upgrade') {
  try {
    const u = await served(), { main } = await crossing();
    if (args.includes('--rollback')) say(await u.rollback({ home, main, running: self }));
    else {
      // The newer client from the home's site, then R18's step: the Souls of today's client come across.
      const bundle = await u.upgradeBundle({ home, version: VERSION }), across = await main([], { env });
      say({ ok: across.ok !== false, ...bundle, home: across });
    }
  } catch (e) { refused(e); }
} else {
  let ready = true;
  if (args[0] === 'pair' && args[1]) {
    try { await (await served()).firstInstall({ home, url: args[1] }); } catch (e) { refused(e); ready = false; }
  }
  if (ready) {
    // The daemon's library for this version: kept, else fetched by hash from the home's site.
    const lib = await (await served()).libFor(home, VERSION).catch(() => null);
    if (lib && !process.env.SOULS_REPLICA_PKG) process.env.SOULS_REPLICA_PKG = join(home, 'bin', 'lib', lib);
    // The command runs when it is the script named; a module's own path has its symlinks resolved (/tmp, /var).
    process.argv[1] = real(join(root, ENTRY));
    await import(pathToFileURL(process.argv[1]).href);
  }
}
