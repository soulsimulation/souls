#!/usr/bin/env node
// #2232: where one load's time, processor and memory go, for a small world (`hello-hamlet`) and Eden 2026. Per world:
// a genesis boot (not counted) joins --souls Souls that never act (fake minds, Eyes off) and stops, so the world has a
// snapshot and Souls like a world in use; then --boots cold boots of that data directory, each timed from spawn:
//   phases from the world's own boot lines (main.ts): `[boot] listening … s after start: code, engine, the rest`,
//   `[boot] projection … ms`, `[boot] prepare … ms`; the database and engine factory are the listen time less the other
//   three; the post-listen cache warm (`edge capability caches warm after listen`) and the first /healthz answer.
//   Processor seconds (utime + stime of the world process, all its threads) and the most memory held (VmHWM, the peak
//   resident set) from /proc/<pid> at listen and again when the post-listen warm ends (Linux only).
// --profile adds one boot per world under `node --cpu-prof` (not counted in the timings): the functions that use the
// most processor time from process start to listen.
// Tools-only; never gated. Through `.github/workflows/timed-run.yml` (command `load`) on a souls-timed runner; locally
// only as a smoke (`--short`, figures indicative).
//
//   node tools/bench/capacity/load/load.mjs [--world small,eden] [--boots 5] [--souls 10] [--profile] [--out <dir>]
//        [--port 4700] [--root <checkout>] [--short]
// Writes <out>/{results.json, REPORT.md, load.log} and <out>/<world>/{world.log, boot-<k>.log, world-command.json}.
// No host name, user, home path or token in results.json or REPORT.md.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; }, flag = (k) => argv.includes(`--${k}`);
const ROOT = resolve(opt('root', new URL('../../../..', import.meta.url).pathname)), SHORT = flag('short'), PROFILE = flag('profile');
const PORT = Number(opt('port', 4700)), BOOTS = Number(opt('boots', SHORT ? 2 : 5)), SOULS = Number(opt('souls', SHORT ? 2 : 10));
const WORLDS = { small: 'hello-hamlet', eden: 'eden-2026' };
const WORLD_LIST = opt('world', 'small,eden').split(',');
for (const w of WORLD_LIST) if (!WORLDS[w]) throw new Error(`--world ${w}: ${Object.keys(WORLDS).join(' | ')}`);
const OUT = resolve(opt('out', join(ROOT, '.local/bench/load', new Date().toISOString().replace(/[:.]/g, '-'))));
const { defaultCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/children.mjs')).href);
const { decorateCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/production.mjs')).href);
const { worldHeapMb } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/registry.mjs')).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const scrub = (s) => String(s).split(ROOT).join('.');
mkdirSync(OUT, { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); appendFileSync(join(OUT, 'load.log'), s + '\n'); };
const MARS_WEB = join(ROOT, 'mars/viewer/dist'), KIT = join(ROOT, 'apps/web/dist/kit-contract.json');
for (const [p, fix] of [[MARS_WEB, 'pnpm build:viewer'], [KIT, 'pnpm --filter @souls/web build']]) if (!existsSync(p)) throw new Error(`missing ${relative(ROOT, p)}: run \`${fix}\` in the checkout`);

// ------------------------------------------------------------------ processor and memory of the world process
const TICK = Number(sh('getconf', ['CLK_TCK']) ?? 100);
/** utime + stime in seconds, and the peak and present resident set in MB, of one process (all its threads); null off Linux. */
function proc(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' '), status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(status)?.[1] ?? NaN) / 1024;
    return { cpuS: +((Number(stat[11]) + Number(stat[12])) / TICK).toFixed(2), hwmMb: +kb('VmHWM').toFixed(1), rssMb: +kb('VmRSS').toFixed(1) };
  } catch { return null; }
}

// ------------------------------------------------------------------ one world process
async function getJ(url, ms = 5000) { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return { status: r.status, j: await r.json().catch(() => null) }; } catch { return { status: 0, j: null }; } }
function command(dir, slug, template) {
  const data = join(dir, 'data'), library = join(dir, 'library'); mkdirSync(data, { recursive: true }); mkdirSync(library, { recursive: true });
  const soul = (f) => join(ROOT, 'tools/world-launcher/soul', f), origin = `http://127.0.0.1:${PORT}`;
  const base = defaultCommand({ slug, dataDir: data, name: `Load ${slug}`, templateFile: join(ROOT, 'worlds/templates', `${template}.json`) }, PORT,
    { publicOrigin: origin, marsWebDir: MARS_WEB, root: ROOT, libraryDir: library, soulControllerCliFile: soul('eden.mjs'), soulCliFile: soul('eden-agent.mjs'), soulSkillFile: soul('skill.md'), soulInstructionsFile: soul('instructions.md') });
  const { cmd: node, args, env } = decorateCommand(base, { devAuth: true, publicOrigin: origin, base: '', worldHeapMb: worldHeapMb({ template }, 0), build: 'dev' });
  Object.assign(env, { MIND_DRIVER: 'edge', BRAIN_MODE: 'fake' });
  for (const k of Object.keys(env)) if (k.startsWith('EDGE_EYES')) delete env[k];   // no renders (Eyes off)
  writeFileSync(join(dir, 'world-command.json'), JSON.stringify({ cmd: [node, ...args].map(scrub), env: Object.fromEntries(Object.entries(env).filter(([k]) => !/KEY|TOKEN|SECRET/.test(k)).map(([k, v]) => [k, scrub(v)])) }, null, 1));
  return { node, args, env, data, origin, slug };
}

const LINES = {
  booted: /\[world\] \S+ booted from (\S+), tick (\d+), replayed (\d+) events, (\d+) souls/,
  owed: /\[clock\] (\d+) ticks owed/,
  caughtUp: /\[clock\] caught up (\d+) ticks .* in (\d+) ms/,
  vacuum: /\[db\] vacuumed at boot in (\d+) ms/,
  projection: /\[boot\] projection (\d+) ms/,
  prepare: /\[boot\] prepare (\d+) ms/,
  listening: /\[boot\] listening ([\d.]+) s after start: code ([\d.]+), engine ([\d.]+), the rest ([\d.]+)/,
  warm: /\[boot\] edge capability caches (?:warm|stopped) after listen: (\d+) ms: .* over (\d+) ms for (\d+) Souls/,
};
/** Spawn the world, note the arrival (s after spawn) and the processor/memory facts at each boot line, until listen,
 *  the post-listen warm (or 60 s) and the first /healthz answer. Returns the live process and what it saw. */
async function boot(c, logFile, extraNodeArgs = []) {
  const seen = {}, at = {}, t0 = performance.now(), load1 = loadavg()[0];
  const child = spawn(c.node, [...extraNodeArgs, ...c.args], { cwd: ROOT, env: c.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', tail = '';
  const onData = (b) => {
    appendFileSync(logFile, b); tail = (tail + b).slice(-4000); buf += b; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      for (const [k, re] of Object.entries(LINES)) { const m = re.exec(line); if (m && !seen[k]) { seen[k] = m.slice(1); at[k] = { s: +((performance.now() - t0) / 1000).toFixed(3), ...proc(child.pid) }; } }
    }
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const why = () => scrub(tail.trim().split('\n').slice(-4).join(' | '));
  let healthS = null;
  while (healthS == null) {
    if (child.exitCode != null) throw new Error(`exited at boot (${child.exitCode}): ${why()}`);
    if (performance.now() - t0 > 900_000) throw new Error(`no /healthz in 15 min: ${why()}`);
    if ((await getJ(`${c.origin}/healthz`, 2000)).j?.ok) healthS = +((performance.now() - t0) / 1000).toFixed(3);
    else await sleep(50);
  }
  for (let k = 0; !seen.warm && k < 600; k++) await sleep(100);
  const end = proc(child.pid);
  return { child, seen, at, healthS, end, load1, why };
}
async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM'); for (let k = 0; k < 120 && child.exitCode == null; k++) await sleep(500);
  if (child.exitCode == null) { child.kill('SIGKILL'); await sleep(500); }
}
const LIVE = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log(`interrupted (${sig})`); await Promise.all([...LIVE].map(stop)); process.exit(130); });

// ------------------------------------------------------------------ Souls that join and never act (the checkout's own CLI, dev identity)
function runCli(dir, args, ms) {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['eden.mjs', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-500); }); p.stdout.resume();
    const k = setTimeout(() => p.kill('SIGKILL'), ms); p.on('exit', (code) => { clearTimeout(k); done({ code, err: err.trim().split('\n').at(-1) ?? '' }); });
  });
}
/** The CLI wants a world URL …/w/<slug>; a directly booted world has no such prefix, so a loopback proxy strips it. */
async function joinProxy(c) {
  const prefix = `/w/${c.slug}`, target = new URL(c.origin);
  const srv = createServer((req, res) => {
    const path = req.url.startsWith(prefix) ? req.url.slice(prefix.length) || '/' : req.url;
    const up = httpRequest({ host: target.hostname, port: target.port, method: req.method, path, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
  });
  await new Promise((ok) => srv.listen(PORT + 1, '127.0.0.1', ok));
  return { url: `http://localhost:${PORT + 1}${prefix}`, close: () => new Promise((ok) => srv.close(ok)) };
}
async function joinSoul(dir, c, url, i) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'eden.mjs'), Buffer.from(await (await fetch(`${c.origin}/eden.mjs`)).arrayBuffer()));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ identity: `agent-load-${c.slug}-${i}` }) + '\n', { mode: 0o600 });
  const reg = await runCli(dir, ['register', url], 60_000); if (reg.code) log(`soul ${i} register: ${reg.code} ${scrub(reg.err)}`);
  const token = () => { try { return JSON.parse(readFileSync(join(dir, '.eden-agent.json'), 'utf8')).token ?? null; } catch { return null; } };
  for (let k = 0; !token() && k < 3; k++) { const r = await runCli(dir, ['create', `Load${i}`], 150_000); if (!token()) { log(`soul ${i} create: ${r.code} ${scrub(r.err)}`); await sleep(2000); } }
  if (!token()) throw new Error(`soul ${i} did not join`);
}

// ------------------------------------------------------------------ one boot's phases (seconds)
function phases(b) {
  const L = b.seen.listening?.map(Number), num = (k, i = 0) => (b.seen[k] ? Number(b.seen[k][i]) : null);
  if (!L) return { error: `no listening line: ${b.why()}` };
  const [listenS, codeS, engineS, restS] = L, projS = (num('projection') ?? 0) / 1000, prepS = (num('prepare') ?? 0) / 1000;
  const r3 = (x) => +x.toFixed(3);
  return {
    processStartS: codeS,                                   // node start and the server's imports (bootAt.code)
    dbFactoryS: r3(listenS - codeS - engineS - restS),       // database open, migrations, ground recipes, engine factory
    snapshotS: engineS,                                     // host.boot: snapshot restore and replay, the repair adoption
    otherSetupS: r3(restS - projS - prepS),                 // Eden core, auth, the edge and Souls, catch-up started
    projectionS: r3(projS),                                 // initial physics projection (terrain and walking grid)
    prepareS: r3(prepS),                                    // serving caches (recorder state)
    listenS,                                                // process start to listen (the world's own clock)
    healthS: b.healthS,                                     // spawn to the first /healthz answer (the bench's clock)
    warmMs: num('warm'), warmWallMs: num('warm', 1),        // post-listen edge cache warm (sliced)
    cpuAtListenS: b.at.listening?.cpuS ?? null, peakMbAtListen: b.at.listening?.hwmMb ?? null,
    cpuAtWarmS: b.end?.cpuS ?? null, peakMbAtWarm: b.end?.hwmMb ?? null, rssMbAtWarm: b.end?.rssMb ?? null,
    bootedFrom: b.seen.booted?.[0] ?? null, replayed: num('booted', 2), souls: num('booted', 3), owedTicks: num('owed'), caughtUpMs: num('caughtUp', 1), vacuumMs: num('vacuum'),
    load1: +b.load1.toFixed(2),
  };
}

// ------------------------------------------------------------------ the CPU profile's heaviest functions, start to listen
function profileTop(dir, listenS, n = 15) {
  const f = readdirSync(dir).find((x) => x.endsWith('.cpuprofile')); if (!f) return null;
  const p = JSON.parse(readFileSync(join(dir, f), 'utf8')), byId = new Map(p.nodes.map((x) => [x.id, x])), self = new Map(), byFile = new Map();
  let t = 0, total = 0; const cut = listenS * 1e6;
  for (let i = 0; i < p.samples.length; i++) {
    t += p.timeDeltas[i]; if (t > cut) break; const dt = p.timeDeltas[i + 1] ?? 0, cf = byId.get(p.samples[i]).callFrame; total += dt;
    const url = scrub(cf.url.replace(/^file:\/\//, '')).replace(/^.*node_modules\//, 'node_modules/'), key = `${cf.functionName || '(anonymous)'} ${url}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt); const file = url || cf.functionName; byFile.set(file, (byFile.get(file) ?? 0) + dt);
  }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => ({ k, ms: Math.round(us / 1000), pct: +((100 * us) / total).toFixed(1) }));
  return { sampledMs: Math.round(total / 1000), functions: top(self), files: top(byFile) };
}

// ------------------------------------------------------------------ one world: genesis, then the cold boots
async function world(name) {
  const template = WORLDS[name], dir = join(OUT, name); mkdirSync(dir, { recursive: true });
  const c = command(dir, `ld-${name}`, template), r = { world: name, template, souls: SOULS, boots: [] };
  log(`${name}: genesis from ${template}`);
  const g = await boot(c, join(dir, 'world.log')); LIVE.add(g.child);
  try {
    if (SOULS) { const jp = await joinProxy(c); try { for (let i = 0; i < SOULS; i++) await joinSoul(join(dir, 'souls', `s${i}`), c, jp.url, i); } finally { await jp.close(); } }
    await sleep(SHORT ? 5000 : 30_000);
  } finally { await stop(g.child); LIVE.delete(g.child); }
  r.genesis = { healthS: g.healthS, exit: g.child.exitCode };
  for (let k = 1; k <= BOOTS; k++) {
    await sleep(3000);
    const b = await boot(c, join(dir, `boot-${k}.log`)); LIVE.add(b.child);
    const ph = phases(b); r.boots.push({ k, ...ph });
    log(`${name} boot ${k}: listen ${ph.listenS} s (code ${ph.processStartS}, db+factory ${ph.dbFactoryS}, snapshot ${ph.snapshotS}, setup ${ph.otherSetupS}, projection ${ph.projectionS}, prepare ${ph.prepareS}), healthz ${ph.healthS} s, warm ${ph.warmWallMs} ms, cpu ${ph.cpuAtListenS}/${ph.cpuAtWarmS} s, peak ${ph.peakMbAtListen}/${ph.peakMbAtWarm} MB, load ${ph.load1}`);
    await stop(b.child); LIVE.delete(b.child);
  }
  if (PROFILE) {
    await sleep(3000);
    const pd = join(dir, 'profile'); mkdirSync(pd, { recursive: true });
    const b = await boot(c, join(dir, 'boot-profile.log'), ['--cpu-prof', '--cpu-prof-dir', pd]); LIVE.add(b.child);
    const ph = phases(b); await stop(b.child); LIVE.delete(b.child);
    r.profile = { listenS: ph.listenS, ...profileTop(pd, ph.listenS ?? 60) };
    log(`${name} profile: listen ${ph.listenS} s, top ${r.profile.functions?.slice(0, 3).map((x) => `${x.k} ${x.ms} ms`).join('; ')}`);
  }
  return r;
}

const commit = sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']);
const receipt = { issue: 2232, commit, node: process.version, platform: process.platform, cpus: cpus().length, memGb: +(totalmem() / 2 ** 30).toFixed(1), loadBefore: loadavg().map((x) => +x.toFixed(2)), boots: BOOTS, souls: SOULS, short: SHORT };
log(`load: worlds ${WORLD_LIST.join(',')}, ${BOOTS} boots, ${SOULS} Souls, commit ${commit?.slice(0, 9)}`);
const results = [];
for (const name of WORLD_LIST) { try { results.push(await world(name)); } catch (e) { results.push({ world: name, error: scrub(e.message ?? e) }); log(`${name}: ${scrub(e.message ?? e)}`); } }
receipt.loadAfter = loadavg().map((x) => +x.toFixed(2));
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ receipt, results }, null, 1) + '\n');

// ------------------------------------------------------------------ the report: medians and ranges per phase
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] + (s.length % 2 ? 0 : (s[s.length >> 1] - s[(s.length - 1) >> 1]) / 2) : null; };
const f = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));
const COLS = [['processStartS', 'process start (node, imports)'], ['dbFactoryS', 'database and engine factory'], ['snapshotS', 'snapshot load and replay'], ['otherSetupS', 'other setup (Eden core, auth, edge, Souls)'], ['projectionS', 'initial physics projection (terrain, walking grid)'], ['prepareS', 'serving caches'], ['listenS', '**first listen (process start → listen)**'], ['healthS', 'spawn → first /healthz'], ['warmWallMs', 'after listen: edge cache warm (wall, s)'], ['cpuAtListenS', 'processor s to listen'], ['cpuAtWarmS', 'processor s to warm end'], ['peakMbAtListen', 'peak resident MB to listen'], ['peakMbAtWarm', 'peak resident MB to warm end'], ['load1', 'host 1-min load at spawn']];
const lines = ['# Load phases (#2232)', '', `commit ${commit?.slice(0, 9) ?? ''} · node ${process.version} · ${receipt.cpus} CPUs · ${receipt.memGb} GB · load ${receipt.loadBefore.join(' ')} → ${receipt.loadAfter.join(' ')} · ${BOOTS} boots, ${SOULS} Souls${SHORT ? ' · SHORT (indicative)' : ''}`, ''];
for (const r of results) {
  if (r.error) { lines.push(`## ${r.world}: error`, '', r.error, ''); continue; }
  lines.push(`## ${r.template} (${r.souls} Souls)`, '', `| phase | median | ${r.boots.map((b) => `boot ${b.k}`).join(' | ')} |`, `|---|---|${r.boots.map(() => '---').join('|')}|`);
  for (const [k, label] of COLS) { const v = (b) => (k === 'warmWallMs' && b[k] != null ? b[k] / 1000 : b[k]); const d = /Mb/.test(k) ? 0 : 2; lines.push(`| ${label} | ${f(med(r.boots.map(v)), d)} | ${r.boots.map((b) => f(v(b), d)).join(' | ')} |`); }
  lines.push('', `booted from ${[...new Set(r.boots.map((b) => b.bootedFrom))].join(', ')}; replayed ${r.boots.map((b) => b.replayed).join(', ')} events; owed ticks ${r.boots.map((b) => b.owedTicks ?? 0).join(', ')}; caught up in ${r.boots.map((b) => b.caughtUpMs ?? '—').join(', ')} ms`, '');
  if (r.profile?.functions) lines.push(`Profile boot (not counted): listen ${f(r.profile.listenS)} s, ${r.profile.sampledMs} ms sampled to listen.`, '', '| self time, function | ms | % |', '|---|---|---|', ...r.profile.functions.map((x) => `| \`${x.k}\` | ${x.ms} | ${x.pct} |`), '', '| self time, file | ms | % |', '|---|---|---|', ...r.profile.files.map((x) => `| \`${x.k}\` | ${x.ms} | ${x.pct} |`), '');
}
writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n') + '\n');
log('done: REPORT.md');
