#!/usr/bin/env node
// #2301: the checkout's own launcher (openLauncher from tools/world-launcher/launcher.mjs), started in this process with
// the bench's knobs, which its command line does not take: the still-world times (#2299 stillQuietMs …) and extra world
// environment (SIM_BODY_KNOBS for a short wind-down, SIM_BOOT_HASH). Everything else is the launcher as it runs on a
// host. Bench only; never used by a release.
//
//   node launch.mjs <config.json>
// config: { root, port, range: [a, b], dataDir, marsWebDir, publicOrigin, control, worldEnv: {K: V}, cfg: {…openLauncher} }
// `control` is a loopback port for the bench alone: GET /ps (each world's status, port and pid, the horizons and the
// launcher's own pid), POST /stop/<slug> (the launcher's ordinary clean stop of one world, as an unload does).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const mod = (f) => import(pathToFileURL(join(c.root, 'tools/world-launcher', f)).href);
const { openLauncher } = await mod('launcher.mjs');
const { defaultCommand } = await mod('children.mjs');
const extra = c.worldEnv ?? {};
// the world command is the launcher's own default one, with the bench's extra environment added (forks are not used here)
const command = (w, p, o) => { const d = defaultCommand(w, p, o); d.env = { ...d.env, ...extra }; return d; };
const l = await openLauncher({ root: c.root, port: c.port, range: c.range, dataDir: c.dataDir, marsWebDir: c.marsWebDir, publicOrigin: c.publicOrigin, ...(Object.keys(extra).length ? { command } : {}), ...c.cfg });
const ps = () => ({ pid: process.pid, worlds: Object.fromEntries(l.registry.worlds.map(({ slug }) => { const s = l.pool.status(slug); return [slug, { status: s.status, port: s.port ?? null, pid: s.pid ?? null }]; })), horizons: Object.fromEntries(l.still?.horizons ?? []) });
const ctl = createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && req.url === '/ps') return send(200, ps());
    const m = /^\/stop\/([a-z][a-z0-9-]{0,31})$/.exec(req.url ?? '');
    if (req.method === 'POST' && m) { await l.pool.stop(m[1]); return send(200, { ok: true }); }
    send(404, { ok: false });
  } catch (e) { send(500, { ok: false, error: String(e.message ?? e) }); }
});
ctl.listen(c.control, '127.0.0.1');
console.log(`[bench] launcher ${l.build ?? ''} on :${c.port}, control :${c.control}${Object.keys(extra).length ? `, world env ${Object.keys(extra).join(' ')}` : ''}`);
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (stopping) return; stopping = true; ctl.close(); void l.close().then(() => process.exit(0)); });
