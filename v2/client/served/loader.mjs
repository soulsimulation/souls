// The served client's loader (Engine v2 R17, #2818): the tail of eden.mjs. build.mjs writes VERSION, ENTRY (the thin
// command's path) and FILES (the client's modules by repo-relative path) above it; not run on its own.
//
// - The home is `--home <path>`, else SOULS_HOME, else the nearest .souls folder that exists upward from here to the
//   user's home folder, else ./.souls; a command that adds to a home takes ./.souls (0.133 Q2). The command it runs,
//   or the copy it hands off to, is given that home as SOULS_HOME. A new home gets a `.gitignore` of everything.
// - A copy that is not the home's `.souls/bin/eden.mjs` hands off to that one, its arguments unchanged, unless this
//   copy is newer (docs/architecture/api.md, "Soul client upgrade", frozen).
// - The modules are unpacked once into `.souls/bin/client/<version>-<digest>/` and the thin command runs from there,
//   so its daemon and its pairing start from files, as they do in the repository.
// - `pair <world url>` in a home with no client first installs it (`../src/upgrade/served.mjs`): the world's address
//   becomes the home's one trusted site, and the client, the skill and the daemon's library are fetched from it, each
//   checked by length and hash before anything is written. A command whose version has no library yet fetches it.
// - `upgrade`: a newer client from that site (served.mjs), then R18's `main` (`../src/upgrade/upgrade.mjs`), which
//   brings the home's Souls of today's client across; `upgrade --rollback`: R18's `main`, then the daemons hand over.
// - `god <verb> ...` runs the creator's command (`../src/creator/souls-god.mjs`); `god pair <world url> --creator
//   <grant>` in a home with no client first installs it, as `pair` does.
// - `version` prints the version.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const say = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

// 0.133 Q2: a command that adds to a home (home.mjs ADDS: pair, login, adopt, import; `god pair`) never takes a parent
// folder's: it installs into and pairs in this folder's own `.souls`, unless its person names one (`--home <path>`).
const ADDS = new Set(['pair', 'login', 'adopt', 'import']);
function findHome(argv) {
  const k = argv.indexOf('--home');
  if (k >= 0 && argv[k + 1]) return resolve(argv[k + 1]);
  if (process.env.SOULS_HOME) return resolve(process.env.SOULS_HOME);
  const start = real(process.cwd()), stop = real(homedir());
  if (ADDS.has(argv[0] === 'god' ? argv[1] : argv[0])) return join(start, '.souls');
  // the nearest `.souls` that exists, a home or one still pairing: never past it to a parent folder's
  for (let dir = start; ; dir = dirname(dir)) {
    const h = join(dir, '.souls');
    if (existsSync(h)) return h;
    if (dir === stop || dirname(dir) === dir) return join(start, '.souls');
  }
}

const num = (v) => v.split('.').map(Number);
const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const versionIn = (file) => { try { return /^const VERSION = "(\d+\.\d+\.\d+)";$/m.exec(readFileSync(file, 'utf8'))?.[1]; } catch { return undefined; } };

const home = findHome(process.argv.slice(2));
// `--home <path>` is taken here: what runs next is given the home as SOULS_HOME, its words without it (0.133 Q2)
const at = process.argv.indexOf('--home', 2);
if (at >= 0 && process.argv[at + 1]) process.argv.splice(at, 2);
const args = process.argv.slice(2);
process.env.SOULS_HOME = home;
if (!existsSync(home)) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.gitignore'), "# A Souls home: its credentials and its Souls' own files. Never committed.\n*\n");
}
const installed = join(home, 'bin', 'eden.mjs');
const self = fileURLToPath(import.meta.url);

const theirs = real(self) !== real(installed) && versionIn(installed);
if (theirs && !newer(VERSION, theirs)) {
  const r = spawnSync(process.execPath, [installed, ...args], { stdio: 'inherit', env: process.env });
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
  // `god <verb> ...`: the creator's command (souls-god.mjs, G7) from the same files, for a world's creator.
  const god = args[0] === 'god', rest = god ? args.slice(1) : args;
  let ready = true;
  if (rest[0] === 'pair' && rest[1]) {
    try { await (await served()).firstInstall({ home, url: rest[1] }); } catch (e) { refused(e); ready = false; }
  }
  if (ready) {
    // The daemon's library for this version: kept, else fetched by hash from the home's site.
    const lib = await (await served()).libFor(home, VERSION).catch(() => null);
    if (lib && !process.env.SOULS_REPLICA_PKG) process.env.SOULS_REPLICA_PKG = join(home, 'bin', 'lib', lib);
    // The command runs when it is the script named; a module's own path has its symlinks resolved (/tmp, /var).
    process.argv[1] = real(join(root, god ? 'v2/client/src/creator/souls-god.mjs' : ENTRY));
    if (god) process.argv.splice(2, 1);
    await import(pathToFileURL(process.argv[1]).href);
  }
}
