#!/usr/bin/env node
// A local stand-in for the front door (Engine v2 O19, #2830). A scratch host under .local/: Caddy in today's layout
// (a Caddyfile importing sites/*.caddy and cdn-trust.snippet, today's soul-game.caddy and sim-eden-art.caddy) on
// loopback, in front of a real launcher (fake minds, a synthetic Clerk issuer, production's satellite and primary
// settings, an alias and the /worlds prefix from reslug), a directory answering W3's GET /v1/worlds, the viewers' origin
// and the new page's built files. Then, from outside with front-check.mjs: before the switch (must fail), the README's
// SWITCH script, every point, the poster and the site's pages (O23) with the launcher stopped, the README's BACK script, and again (must fail).
// Production's names, paths and ports are swapped for the scratch host's; the scripts run as written otherwise, with a
// systemctl that reloads the scratch Caddy and runs the unit's ExecStart.
//   BRAIN_MODE=fake node v2/tools/ops/proxy/standin.mjs --web <v2/web build> --today-web <apps/web build> [--keep]
// Exit 0 when every step comes out as it should.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLauncher } from '../../../../tools/world-launcher/launcher.mjs';
import { migrateRegistry } from '../../../../tools/world-launcher/reslug.mjs';
import { clerkKeys, ISSUER, PUBLISHABLE_KEY } from '../../../../apps/server/test/clerk-fixture.ts';
import { testPort } from '../../../../apps/server/test/test-port.ts';
import { createOrigin } from '../../origin/origin.mjs';
import { build } from '../../../client/served/build.mjs';
import { frontCheck, POINTS } from '../front-check.mjs';

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../../..');
const today = join(repo, 'tools/world-launcher/deploy/caddy');
const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const web = resolve(opt('--web', join(repo, 'v2/web/dist'))), todayWeb = resolve(opt('--today-web', join(repo, 'apps/web/dist')));
mkdirSync(join(repo, '.local'), { recursive: true });
const dir = mkdtempSync(join(repo, '.local', 'front-door-'));
const P0 = await testPort(16);
const port = { launcher: P0 + 9, directory: P0 + 10, origin: P0 + 11, admin: P0 + 12, public: P0 + 13, primary: P0 + 14, old: P0 + 15 };
const at = (p) => `http://127.0.0.1:${p}`;
const PUBLIC = 'https://soul.game', PRIMARY = 'https://sim.eden.art', OLD = 'https://souls.game';
const stops = [];
const log = (s) => console.log(`standin: ${s}`);

// today's launcher, as production runs it: the public origin, the satellite and the primary's sign-in bridge
const keys = await clerkKeys(PUBLIC);
writeFileSync(join(dir, 'jwks.json'), JSON.stringify({ keys: [keys.jwk] }));
const envFile = join(dir, 'clerk.env'), templatesDir = join(dir, 'templates'), dataDir = join(dir, 'data');
mkdirSync(templatesDir);
writeFileSync(envFile, [`CLERK_PUBLISHABLE_KEY=${PUBLISHABLE_KEY}`, `CLERK_ISSUER_URL=${ISSUER}`, `CLERK_AUTHORIZED_PARTIES=${PUBLIC},${PRIMARY}`,
  `SIM_TEST_JWKS_FILE=${join(dir, 'jwks.json')}`, `NODE_OPTIONS=--import=${join(repo, 'apps/server/test/clerk-jwks-preload.mjs')}`, 'BRAIN_MODE=fake', ''].join('\n'));
const launcherCfg = { port: port.launcher, range: [P0, P0 + 8], dataDir, templatesDir, webDir: todayWeb, authEnvFile: envFile, publicOrigin: PUBLIC,
  clerkSatellite: 'soul.game', clerkSignInUrl: `${PRIMARY}/sign-in`, eager: 0, log: () => {} };
let L = await openLauncher(launcherCfg);
const slugs = [];
for (const name of ['Eden 2026', 'Mars College 2027', 'Rehearsal (scratch)']) {
  const token = await keys.sign(`user_${slugs.length}`);
  const r = await fetch(`${at(port.launcher)}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name, template: 'empty' }) });
  const made = await r.json();
  if (r.status !== 201) throw Error(`creating ${name}: ${r.status} ${JSON.stringify(made)}`);
  slugs.push(made.slug);
  log(`today's launcher made ${made.slug}`);
}
await L.close();
migrateRegistry(dataDir, [[slugs[0], 'eden']], { apply: true, offline: true });   // its slug and /worlds/w/<slug>/ become eden's old addresses
L = await openLauncher(launcherCfg);
stops.push(() => L?.close());

// the new system: the directory's list (W3's answer: eden moves across, new-town was made there) and the viewers' origin
const listed = { worlds: [{ name: 'eden', label: 'standin', template: 'eden', lineage: '00'.repeat(16), zone: 'z', creator: 'c', made: 0, awake: true, picture: null },
  { name: 'new-town', label: 'standin', template: 'eden', lineage: '11'.repeat(16), zone: 'z', creator: 'c', made: 0, awake: false, picture: null }], templates: ['eden'] };
const directory = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/worlds') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=5' }).end(JSON.stringify(listed));
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"refused":"not-found"}');
}).listen(port.directory, '127.0.0.1');
const streams = join(dir, 'streams');
mkdirSync(streams);
writeFileSync(join(streams, 'pointer'), 'standin');
// the site's pages (O23): the page's changelog files and one release in news.jsonl, as release.sh news writes it
const news = join(dir, 'news');
mkdirSync(news);
writeFileSync(join(news, 'news.jsonl'), `${JSON.stringify({ kind: 'release', version: '0.0-standin', commit: '0'.repeat(40), date: '2026-11-19', link: `${PUBLIC}/changelog#v0.0-standin` })}\n`);
const client = join(dir, 'client');
build({ out: client, version: '0.0.0' });
const worldRoutes = join(dir, 'world-routes.json');
writeFileSync(worldRoutes, JSON.stringify({ schema: 'souls/world-routes/1', worlds: Object.fromEntries(listed.worlds.map(w => [w.name, { gateway: at(port.directory), stream: '/s/standin/', canonical: true }])) }));
const origin = createOrigin(streams, { web, data: news, client, worldRoutes }).server.listen(port.origin, '127.0.0.1');
stops.push(() => directory.close(), () => origin.close());

// the scratch host: /etc, the live release and the map under the scratch folder
const etc = join(dir, 'etc'), release = join(dir, 'release'), routes = join(dir, 'routes'), shims = join(dir, 'bin');
const src = join(release, 'v2/tools/ops/proxy');
for (const d of [join(etc, 'caddy/sites'), join(etc, 'sim-worlds'), join(etc, 'systemd/system'), src, shims, routes]) mkdirSync(d, { recursive: true });
const names = (text) => text
  .replace(/^https:\/\/soul\.game \{/m, `http://127.0.0.1:${port.public} {`)
  .replace(/^https:\/\/sim\.eden\.art \{/m, `http://127.0.0.1:${port.primary} {`)
  .replace(/^https:\/\/souls\.game \{/m, `http://127.0.0.1:${port.old} {`)
  .replaceAll('localhost:7310', `localhost:${port.directory}`).replaceAll('localhost:7320', `localhost:${port.origin}`)
  .replaceAll('/usr/local/lib/souls/web', web).replaceAll('/var/lib/souls/models', join(dir, 'models')).replaceAll('/var/lib/souls-routes', routes).replaceAll('/usr/bin/node', process.execPath)
  .replaceAll('/srv/sim-worlds/production/tools/world-launcher/deploy/caddy', today).replaceAll('/srv/sim-worlds/production', release);
for (const f of ['soul-game.caddy', 'souls-game.caddy', 'souls-routes.service', 'souls-routes.timer']) writeFileSync(join(src, f), names(readFileSync(join(here, f), 'utf8')));
writeFileSync(join(src, 'routes.mjs'), readFileSync(join(here, 'routes.mjs')));
const originModules = join(release, 'v2/tools/origin');
mkdirSync(originModules, { recursive: true });
writeFileSync(join(originModules, 'world-routes.mjs'), readFileSync(join(here, '../../origin/world-routes.mjs')));
writeFileSync(join(originModules, 'upgrade-refusal.mjs'), readFileSync(join(here, '../../origin/upgrade-refusal.mjs')));
writeFileSync(join(etc, 'sim-worlds/production.conf'), `SIM_WORLDS_ARGS="--port ${port.launcher} --data /nowhere"\n`);
writeFileSync(join(etc, 'caddy/cdn-trust.snippet'), readFileSync(join(today, 'cdn-trust.snippet')));
writeFileSync(join(etc, 'caddy/Caddyfile'), `{\n\tadmin localhost:${port.admin}\n\tauto_https off\n\timport cdn-trust.snippet\n}\nimport sites/*.caddy\n`);
for (const f of ['soul-game.caddy', 'sim-eden-art.caddy']) writeFileSync(join(etc, 'caddy/sites', f), names(readFileSync(join(today, f), 'utf8')).replaceAll('@@PRODUCTION_PORT@@', String(port.launcher)));
// systemctl on the scratch host: a reload is the scratch Caddy's, a start runs the unit's ExecStart, the rest does nothing
writeFileSync(join(shims, 'systemctl'), `#!/bin/bash\ncase "$*" in\n  "reload caddy") exec caddy reload --config ${join(etc, 'caddy/Caddyfile')} --address localhost:${port.admin} 2>/dev/null ;;\n`
  + `  "start souls-routes.service") eval "$(sed -n 's/^ExecStart=//p' ${join(etc, 'systemd/system/souls-routes.service')})" ;;\n  *) exit 0 ;;\nesac\n`, { mode: 0o755 });
const caddyfile = join(etc, 'caddy/Caddyfile');
try { execFileSync('caddy', ['validate', '--config', caddyfile], { stdio: 'pipe' }); } catch (e) { throw Error(`caddy validate: ${String(e.stderr).split('\n').filter((l) => /error/.test(l)).join('\n')}`); }
const caddy = spawn('caddy', ['run', '--config', caddyfile], { stdio: ['ignore', 'ignore', 'pipe'] });
let caddyLog = '';
caddy.stderr.on('data', (d) => { caddyLog += d; });
stops.push(() => caddy.kill());
for (let i = 0; i < 100; i++) { try { await fetch(at(port.public) + '/robots.txt'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

/** The README's script `name`, run on the scratch host as root runs it on production (not blocking: it calls back here). */
async function script(name) {
  const text = readFileSync(join(here, 'README.md'), 'utf8'), body = new RegExp(`bash -s <<'${name}'\\n([\\s\\S]*?)\\n${name}\\n`).exec(text)?.[1];
  if (!body) throw Error(`README.md has no ${name} script`);
  const local = body.replaceAll('/etc/', etc + '/').replaceAll('/srv/sim-worlds/production', release).replaceAll('localhost:7310', `localhost:${port.directory}`);
  const sh = spawn('bash', ['-s'], { env: { ...process.env, SOULS_WORLD_ROUTES: worldRoutes, PATH: `${shims}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  sh.stdout.on('data', (d) => { out += d; });
  sh.stderr.resume();
  sh.stdin.end(local);
  const code = await new Promise((yes) => sh.on('close', yes));
  log(`${name} (exit ${code}): ${out.trim().split('\n').join(' | ')}`);
  if (code !== 0) throw Error(`${name} failed`);
}

const map = { [PUBLIC]: at(port.public), [PRIMARY]: at(port.primary), [OLD]: at(port.old) };
const run = async (title, extra, quiet = false) => {
  const r = await frontCheck({ public: PUBLIC, primary: PRIMARY, old: [OLD], v2: 'eden', today: slugs[1], aliases: [[slugs[0], 'eden']], unlisted: slugs[2], map, ...extra });
  console.log(`== ${title}`);
  if (!quiet) for (const s of r.seen) console.log(`  ${s}`);
  for (const p of r.problems) console.log(`  PROBLEM ${p}`);
  console.log(r.pass ? 'PASS' : 'FAIL');
  return r.pass;
};
let pass = false;
try {
  const before = await run('before the switch (must fail: today serves every world)', { points: ['worlds', 'list'] }, true);
  await script('SWITCH');
  const up = await run('switched, everything up', { points: POINTS });
  await L.close();
  L = null;
  const down = await run("switched, today's launcher stopped", { points: ['poster', 'site', 'client'], today: undefined, stopped: `/w/${slugs[1]}/` });
  L = await openLauncher(launcherCfg);
  await script('BACK');
  const back = await run('switched back (must fail as before the switch)', { points: ['worlds', 'list'] }, true);
  const old = await fetch(at(port.old)).then(() => 'answers', () => 'refused');
  log(`switched back: the souls.game stand-in ${old}`);
  pass = !before && up && down && !back && old === 'refused';
} finally {
  for (const s of stops.reverse()) { try { await s(); } catch { /* stopping */ } }
  if (!pass) console.log(caddyLog.split('\n').filter((l) => /"level":"error"/.test(l)).slice(-5).join('\n'));
  if (!a.includes('--keep')) rmSync(dir, { recursive: true, force: true });
}
console.log(pass ? 'standin: PASS (fails before, passes switched, poster when stopped, fails again switched back)' : 'standin: FAIL');
process.exitCode = pass ? 0 : 1;
