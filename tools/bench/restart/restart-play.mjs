// #1750 A4 / #1766 T3 playtest: Souls acting through a world restart. Arms: base (SIM_SERVING_BOOT_WAIT_MS=15000, the
// boot warm waited for as long as any other warm, as before #1750) and cand (the default 1 s, then a named world.busy).
//   node tools/bench/restart/restart-play.mjs prepare <root> <out>          a fresh Eden 2026 world, 6 Souls created
//                                                                           through the CLI, then stopped
//   node tools/bench/restart/restart-play.mjs run <root> <out> <arm> <rep>  copy the prepared data, boot, 20 s of load,
//                                                                           SIGTERM and restart, measure the 60 s after
// Each Soul loops: GET here, POST act (a random walk/sit/read/sit-ground/wave/look id from the catalog, strict), 300-700 ms
// rest. Counted in the window: calls; unanswered (no answer in 25 s); world.busy; soul.slow-down/soul.busy; accepted acts;
// client ms; the largest Server-Timing warm;dur; min tick service from /healthz; the boot's warm line; [stall] lines.
// Fake minds, no model; the world is this script's own child on a free port; tokens are the ones this script's Souls got.
// The built web and viewer come from <root> (or SIM_WEB_ROOT, a checkout that has them built).
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request, Agent } from 'node:http';
import { createServer } from 'node:net';

const [cmd, rootArg, outArg, arm, rep] = process.argv.slice(2);
const ROOT = resolve(rootArg), OUT = resolve(outArg), N = 6, SLUG = 'edenx', WEB_ROOT = resolve(process.env.SIM_WEB_ROOT ?? ROOT);
const COMMIT = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const env = (port, data, extra = {}) => ({ ...process.env, WORLD_KEY: SLUG, WORLD_ID: `${SLUG}-1`, WORLD_PATH: `/w/${SLUG}`, ENGINE: 'mars', PORT: String(port), DEV_AUTH: '1', BRAIN_MODE: 'fake', SEED_NATIVES: '0', EDGE_FADING: '1', INVITE_REQUIRED: '0', AUTH_PROVIDER: 'none', DATA_DIR: data, PUBLIC_URL: `http://127.0.0.1:${port}`, GENESIS_FILE: join(ROOT, 'worlds/templates/eden-2026.json'), MARS_WEB_DIR: join(WEB_ROOT, 'mars/viewer/dist/client'), WEB_DIR: join(WEB_ROOT, 'apps/web/dist'), ...extra });
function startWorld(port, data, log, extra) {
  const child = spawn(process.execPath, ['apps/server/src/main.ts'], { cwd: ROOT, env: env(port, data, extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => appendFileSync(log, d)); child.stderr.on('data', (d) => appendFileSync(log, d));
  return child;
}
const agent = new Agent({ keepAlive: true });
function call(port, method, path, token, body) {
  return new Promise((res) => {
    const t0 = performance.now(), data = body ? JSON.stringify(body) : null;
    const req = request({ host: '127.0.0.1', port, method, path: `/w/${SLUG}${path}`, agent, timeout: 25_000, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}) } }, (r) => {
      let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} const st = r.headers['server-timing'] ?? '';
        res({ status: r.statusCode, ms: performance.now() - t0, code: j?.error?.code ?? j?.code ?? null, accepted: !!j?.accepted, world: Number(/world;dur=([\d.]+)/.exec(st)?.[1] ?? NaN), warm: Number(/warm;dur=([\d.]+)/.exec(st)?.[1] ?? 0), body: j }); }); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => res({ status: 0, ms: performance.now() - t0, code: e.message === 'timeout' ? 'unanswered' : 'refused-connection', world: NaN, warm: 0 }));
    req.end(data ?? undefined);
  });
}
async function waitUp(port, ms = 180_000) { const t = Date.now(); while (Date.now() - t < ms) { const r = await call(port, 'GET', '/healthz'); if (r.status === 200) return; await sleep(250); } throw new Error('world did not come up'); }

if (cmd === 'prepare') {
  const data = join(OUT, 'template'), port = await freePort(); mkdirSync(data, { recursive: true });
  const w = startWorld(port, data, join(OUT, 'prepare.log')); await waitUp(port);
  const souls = [];
  for (let i = 0; i < N; i++) {
    const dir = join(OUT, 'souls', `s${i}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'eden.mjs'), Buffer.from(await (await fetch(`http://127.0.0.1:${port}/w/${SLUG}/eden.mjs`)).arrayBuffer()));
    writeFileSync(join(dir, '.eden-agent.json'), '{}\n', { mode: 0o600 });
    execFileSync(process.execPath, ['eden.mjs', 'register', `http://127.0.0.1:${port}/w/${SLUG}`], { cwd: dir, stdio: 'ignore' });
    execFileSync(process.execPath, ['eden.mjs', 'create', `Restart${i}`], { cwd: dir, stdio: 'ignore', timeout: 150_000 });
    souls.push(JSON.parse(readFileSync(join(dir, '.eden-agent.json'), 'utf8')).token);
  }
  const cat = (await (await fetch(`http://127.0.0.1:${port}/w/${SLUG}/v1/edge/catalog`)).json()).acts.map((a) => a.id).filter((id) => /^(walk|sit|read|look):/.test(id));
  writeFileSync(join(OUT, 'souls.json'), JSON.stringify({ tokens: souls, acts: cat.slice(0, 400) }), { mode: 0o600 });
  w.kill('SIGTERM'); await new Promise((r) => w.once('exit', r));
  console.log(`prepared ${N} Souls, ${cat.length} acts`);
} else if (cmd === 'run') {
  const run = join(OUT, `${arm}-r${rep}`), data = join(run, 'data'); mkdirSync(run, { recursive: true });
  cpSync(join(OUT, 'template'), data, { recursive: true });
  const { tokens } = JSON.parse(readFileSync(join(OUT, 'souls.json'), 'utf8'));
  const extra = arm === 'base' ? { SIM_SERVING_BOOT_WAIT_MS: '15000' } : {};
  const port = await freePort(), log = join(run, 'world.log');
  let w = startWorld(port, data, log, extra); await waitUp(port);
  let all = []; for (let k = 0; k < 120 && !all.length; k++) { all = ((await (await fetch(`http://127.0.0.1:${port}/w/${SLUG}/v1/edge/catalog`)).json()).acts ?? []).map((a) => a.id); if (!all.length) await sleep(1000); }
  const kinds = {};
  for (const id of all) { const k = id.split(':')[0]; kinds[k] = (kinds[k] ?? 0) + 1; }
  const acts = all.filter((id) => /^(walk|sit|read|sit-ground|wave|look):/.test(id)); if (!acts.length) throw new Error('no acts: ' + JSON.stringify(kinds));
  const rows = []; let phase = 'before', stop = false, rnd = 7;
  const next = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd; };
  const soul = async (i) => { while (!stop) {
    const t = Date.now();
    const h = await call(port, 'GET', '/v1/edge/here', tokens[i]); rows.push({ phase, t, route: 'here', ...h, body: undefined });
    const a = await call(port, 'POST', '/v1/edge/act', tokens[i], { capability: acts[next() % acts.length], strict: true }); rows.push({ phase, t: Date.now(), route: 'act', ...a, body: undefined });
    await sleep(300 + (next() % 400));
  } };
  const load = tokens.map((_, i) => soul(i));
  await sleep(20_000);
  phase = 'restart'; const tStop = Date.now();
  w.kill('SIGTERM'); await new Promise((r) => w.once('exit', r));
  w = startWorld(port, data, log, extra); await waitUp(port);
  const tUp = Date.now(); phase = 'after';
  const hz = [];
  const hzLoop = (async () => { while (!stop) { const r = await call(port, 'GET', '/healthz'); if (r.body?.load) hz.push(r.body.load.service5s); await sleep(1000); } })();
  await sleep(60_000); stop = true; await Promise.all([...load, hzLoop]);
  w.kill('SIGTERM'); await new Promise((r) => w.once('exit', r));
  const after = rows.filter((r) => r.phase === 'after');
  const ans = after.filter((r) => r.status > 0), q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]) : null; };
  const warmLine = (readFileSync(log, 'utf8').match(/\[boot\] edge capability caches[^\n]*/g) ?? []).at(-1) ?? null;
  const out = { commit: COMMIT, arm, rep: Number(rep), bootWaitMs: arm === 'base' ? 15000 : 1000, souls: N, downS: Math.round((tUp - tStop) / 100) / 10,
    after: { calls: after.length, answered: ans.length, unanswered: after.filter((r) => r.code === 'unanswered').length,
      busy: after.filter((r) => r.code === 'world.busy').length, slowDown: after.filter((r) => r.code === 'soul.slow-down' || r.code === 'soul.busy').length,
      acceptedActs: after.filter((r) => r.route === 'act' && r.accepted).length,
      clientMs: { p50: q(ans.map((r) => r.ms), 0.5), p99: q(ans.map((r) => r.ms), 0.99), max: q(ans.map((r) => r.ms), 1) },
      firstTenS: { p99: q(ans.filter((r) => r.t - tUp < 10_000).map((r) => r.ms), 0.99), max: q(ans.filter((r) => r.t - tUp < 10_000).map((r) => r.ms), 1) },
      warmMsMax: Math.round(Math.max(0, ...after.map((r) => r.warm))), warmCalls: after.filter((r) => r.warm > 0).length,
      serviceMin: hz.length ? Math.min(...hz) : null },
    bootWarm: warmLine, stallLines: (readFileSync(log, 'utf8').match(/^\[stall\][^\n]*/gm) ?? []).length };
  writeFileSync(join(run, 'rows.jsonl'), rows.map((r) => JSON.stringify({ ...r, t: r.t - tUp })).join('\n'));
  writeFileSync(join(run, 'result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
}
