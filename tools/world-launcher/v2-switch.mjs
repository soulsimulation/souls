#!/usr/bin/env node
// B3-1: one command switches a world's old page (apps/web, served by this launcher) to read the new engine, and
// `--back` switches it back. It writes the launcher's cutover binding (cutover.mjs), names the static folder the
// launcher publishes the old world's views into and the body-assets folder it serves, and sets the world's route
// `canonical` flag in the routes file. A running launcher picks the binding and the flag up within a second; no restart.
//
//   node tools/world-launcher/v2-switch.mjs --slug eden --stream /s/eden/ --routes <abs routes.json>
//        --client <abs client dir> --static <abs static dir> --bodies <abs body-assets dir> [--old-world <id>]
//        [--binding <abs file>] [--port <launcher port>]
//   node tools/world-launcher/v2-switch.mjs [--binding <abs file>] [--port <launcher port>] --back
//
//   --binding  the launcher's binding file: SOULS_CUTOVER_BINDING, else /etc/souls/cutover-binding.json, as the launcher
//   --slug     the world's public name; --old-world its registry id (default `<slug>-1`, registry.mjs worldIdOf)
//   --stream   the v2 world's public stream path, `/s/<name>/`, which must reach the v2 origin on the page's origin
//   --routes   the routes file (`souls/world-routes/1`) whose `canonical` flag is the switch; made if missing
//   --client   the folder with the replica the page loads (`replica.js`, `replica_bg.wasm`; v2's wasm-load package)
//   --static   the folder the launcher publishes the old world's static views into (made if missing)
//   --bodies   a built body-assets folder (V2_BODY_ASSETS, with `bodies.json`), served at `/w/<slug>/v2/bodies/`
//   --port     a launcher on this machine: the command then reads the world's page and says what it carries
//
// Run again with no flags but the binding, it switches the bound world on again; flags given replace the binding's.
// `--back` only clears the flag: the page stops naming the stream, the published files are removed and the old world
// answers its reads again. Local and operator use; it never touches a v2 world, the front door or any store.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { cutoverFence } from './cutover.mjs';
import { isMain } from '../lib/is-main.mjs';

const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n'); renameSync(`${file}.tmp`, file); };
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

/** The switch (`back` false) or the way back: the binding and the routes file as they are afterwards. */
export function v2Switch({ binding: file, back = false, slug, oldWorld, stream, routes, client, staticDir, bodies }) {
  if (!isAbsolute(file ?? '')) throw Error('v2-switch.binding-path');
  const given = { canonicalSlug: slug, oldWorldId: oldWorld ?? (slug ? `${slug}-1` : undefined), routesFile: routes, clientDir: client, staticDir, bodiesDir: bodies };
  let binding = readJson(file);
  if (back) { if (!binding) throw Error('v2-switch.no-binding'); }
  else {
    binding = { ...(binding ?? {}), ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) };
    cutoverFence({ binding }); // the launcher's own check: refuses (cutover.binding-invalid) before anything is written
    if (!existsSync(join(binding.clientDir, 'replica.js')) || !existsSync(join(binding.clientDir, 'replica_bg.wasm'))) throw Error('v2-switch.client-missing-replica');
    if (binding.bodiesDir && !existsSync(join(binding.bodiesDir, 'bodies.json'))) throw Error('v2-switch.bodies-missing-catalogue');
    if (binding.staticDir) mkdirSync(binding.staticDir, { recursive: true });
  }
  const table = readJson(binding.routesFile) ?? { schema: 'souls/world-routes/1', worlds: {} };
  if (table.schema !== 'souls/world-routes/1' || !table.worlds || typeof table.worlds !== 'object') throw Error('v2-switch.routes-invalid');
  const route = { ...(table.worlds[binding.canonicalSlug] ?? {}), ...(stream ? { stream } : {}), canonical: !back };
  if (!back && !/^\/s\/[A-Za-z0-9._/-]+\/$/.test(route.stream ?? '')) throw Error('v2-switch.stream-missing');
  if (!back) writeJson(file, binding); // the binding first: the flag never names a world the launcher is not bound to
  writeJson(binding.routesFile, { ...table, worlds: { ...table.worlds, [binding.canonicalSlug]: route } });
  return { binding, route };
}

/** What the world's page on a launcher at `port` carries now: its inline config's v2 fields (null when it names none):
 *  the stream, the body catalogue, and where the owner's box finds the gateway and the directory (B3-2b). */
export async function pageFields(port, slug) {
  const r = await fetch(`http://127.0.0.1:${port}/w/${slug}/`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
  const config = /<script>window\.__simConfig=(\{.*?\})<\/script>/s.exec(await r.text())?.[1];
  const { v2Stream = null, v2Bodies = null, v2Gateway = null, v2Directory = null } = config ? JSON.parse(config) : {};
  return { status: r.status, v2Stream, v2Bodies, v2Gateway, v2Directory };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const { binding, route } = v2Switch({ binding: flag('binding') ?? (process.env.SOULS_CUTOVER_BINDING || '/etc/souls/cutover-binding.json'), back: argv.includes('--back'),
      slug: flag('slug'), oldWorld: flag('old-world'), stream: flag('stream'), routes: flag('routes'), client: flag('client'), staticDir: flag('static'), bodies: flag('bodies') });
    const out = { ok: true, world: binding.canonicalSlug, engine: route.canonical ? 'v2' : 'old', stream: route.stream ?? null };
    if (flag('port')) {
      await new Promise((y) => setTimeout(y, 1200)); // the launcher looks at the binding once a second
      out.page = await pageFields(Number(flag('port')), binding.canonicalSlug);
    }
    console.log(JSON.stringify(out));
  } catch (e) { console.error(JSON.stringify({ ok: false, code: e.message, ...(e.cause ? { cause: String(e.cause.code ?? e.cause) } : {}) })); process.exitCode = 1; }
}
