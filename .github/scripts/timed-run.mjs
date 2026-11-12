#!/usr/bin/env node
// The control side of .github/workflows/timed-run.yml (#1943): a timed run (the walk gate or the scripted Soul eval) on
// a `souls-timed` self-hosted runner, each pinned to cores of its own. #1970 adds the eval's load mode, the capacity
// bench's client load, the meetup workload and the slopes walkers profile; for these four the world under test runs on
// two of the runner's four physical cores and the load generator on the other two. It runs from the workflow's own commit, never
// from the ref under measurement. The argument allowlist is not a security boundary (the ref's own scripts run); safety
// rests on the runner's dedicated, unprivileged account.
//
//   node timed-run.mjs inputs                                        validate INPUT_* env; write step outputs (`target`)
//   node timed-run.mjs load   --record <file>                        starting load; refuse to start above the gate
//   node timed-run.mjs run    --record <file> --out <dir>            the command, `repeats` times (cwd: the ref)
//   node timed-run.mjs stage  --record <file> --out <dir> --dest <dir>   allowlisted, scrubbed copy; refused on a Soul token
//   node timed-run.mjs snapshot --snapshot <file> [--exclude <globs>]   this account's entries of the home and /tmp
//   node timed-run.mjs strays   --snapshot <file> [--exclude <globs>]   fail on entries new since the snapshot
//
// Pure decisions are exported for timed-run.test.mjs. Nothing here prints a path, host or user name.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname, loadavg, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REF_ALLOWED, checkoutRef, scrub } from './capacity-qualify.mjs';

export const COMMANDS = ['walk', 'eval-scripted', 'eval-load', 'bench-client', 'meetup', 'slopes-profile'];
/** #1970: the commands whose world runs on two of the runner's physical cores and whose load generator on the other two. */
export const SPLIT = ['eval-load', 'bench-client', 'meetup', 'slopes-profile'];
export const LOAD_GATE = 0.25;      // mean busy fraction of the runner's own cores above which a run does not start
export const SETTLE_WAIT_S = 300;
export const SAMPLE_S = 5;
const WALK_WORLDS = ['eden-2026', 'bench-eden', 'eden-2026-genesis', 'bench-hamlet', 'fuzz'];
const list = (re, max) => (v) => { const xs = v.split(','); return xs.length <= max && xs.every((x) => re.test(x)) && new Set(xs).size === xs.length; };
const int = (lo, hi) => (v) => /^[1-9]\d{0,3}$/.test(v) && Number(v) >= lo && Number(v) <= hi;
const FLAG = true;   // a bare flag, no value
/** Per command: each flag allowed in `args`, and the check its value must pass (FLAG: a bare flag). Nothing else is accepted. */
export const ARG_ALLOW = {
  walk: { '--world': (v) => v.split(',').every((w) => WALK_WORLDS.includes(w)) && new Set(v.split(',')).size === v.split(',').length },
  'eval-scripted': { '--items': (v) => /^[a-z0-9][a-z0-9-]{0,60}(,[a-z0-9][a-z0-9-]{0,60}){0,20}$/.test(v), '--warm-sec': (v) => /^[1-9]\d{0,2}$/.test(v) && Number(v) <= 600 },
  'eval-load': { '--souls': list(/^(100|[1-9]\d?)$/, 6), '--duration-sec': int(10, 3600), '--card-sec': int(5, 600) },
  'bench-client': { '--arms': list(/^n(100|[1-9]\d?)$/, 6), '--profile': (v) => v === 'real' || v === 'stress', '--raw-from': int(1, 100), '--short': FLAG, '--heap-mb': int(512, 8192) },   // #2164 measurement branch only: --heap-mb
  meetup: { '--profile': (v) => ['even', 'meetup', 'even,meetup', 'real100'].includes(v), '--active-min': int(20, 240), '--short': FLAG },
  'slopes-profile': {},
};

/** `args` → a checked argument list for `command`: whitespace-separated `--flag value` pairs (or bare flags) from its
 *  allowlist, once each. */
export function checkArgs(command, args) {
  const allow = ARG_ALLOW[command], toks = String(args ?? '').trim().split(/\s+/).filter(Boolean), out = [], seen = new Set();
  for (let i = 0; i < toks.length; i += 2) {
    const f = toks[i], v = toks[i + 1];
    if (!Object.hasOwn(allow, f)) throw new Error(`input args: ${JSON.stringify(f)} is not allowed for ${command} (allowed: ${Object.keys(allow).join(', ') || 'none'})`);
    if (seen.has(f)) throw new Error(`input args: ${f} given twice`);
    seen.add(f);
    if (allow[f] === FLAG) { out.push(f); i--; continue; }
    if (v == null || !allow[f](v)) throw new Error(`input args: ${f} ${JSON.stringify(v ?? '')} is not a valid value`);
    out.push(f, v);
  }
  return out;
}

/** INPUT_* env → validated inputs; throws on anything malformed. */
export function parseInputs(env) {
  const bad = (k, v, why) => { throw new Error(`input ${k}=${JSON.stringify(v)}: ${why}`); };
  const ref = String(env.INPUT_REF ?? '');
  if (!REF_ALLOWED.test(ref) || ref.includes('..') || ref.endsWith('.') || ref.endsWith('.lock')) bad('ref', ref, 'main or an agent/<name> branch of this repository');
  const command = String(env.INPUT_COMMAND ?? '');
  if (!COMMANDS.includes(command)) bad('command', command, COMMANDS.join(' or '));
  const repeats = String(env.INPUT_REPEATS ?? '1');
  if (!/^[1-3]$/.test(repeats)) bad('repeats', repeats, '1, 2 or 3');
  return { ref, command, repeats: Number(repeats), args: checkArgs(command, env.INPUT_ARGS) };
}

/** Consecutive ports each command uses from its base port (slopes: quiet worlds +1..+9, join proxy +40, inspector +50). */
export const PORT_SPAN = { walk: 1, 'eval-scripted': 1, 'eval-load': 1, 'bench-client': 3, meetup: 31, 'slopes-profile': 51 };
/** The process to run for one repeat (cwd: the ref). Every command but walk does all its repeats in one invocation. The
 *  eval's load mode keeps its Soul folders (--keep-data) in the per-run directory, so the token refusal can read them. */
export function commandLine(inp, { out, port }) {
  const r = ['--repeats', String(inp.repeats)], p = String(port);
  switch (inp.command) {
    case 'walk': return ['tools/test-harness/walk/walk.mjs', ...inp.args];
    case 'eval-scripted': return ['tools/playtest/eval/soul-eval.mjs', 'run', ...r, '--out', join(out, 'eval'), '--port', p, ...inp.args];
    case 'eval-load': return ['tools/playtest/eval/soul-eval.mjs', 'load', ...r, '--out', join(out, 'eval-load'), '--port', p, '--keep-data', ...inp.args];
    case 'bench-client': return ['tools/bench/capacity/bench.mjs', '--load', 'client', '--via-launcher', ...r, '--out', join(out, 'bench'), '--port', p, '--child-range', `${port + 1}-${port + 2}`, ...inp.args];
    case 'meetup': return ['tools/bench/capacity/meetup/meetup.mjs', ...r, '--out', join(out, 'meetup'), '--port', p, '--range', `${port + 1}-${port + 30}`, ...inp.args];
    case 'slopes-profile': return ['tools/bench/capacity/slopes/slopes.mjs', '--axis', 'walkers', '--cpu-prof', ...r, '--out', join(out, 'slopes'), '--port', p, ...inp.args];
  }
  throw new Error(`no command line for ${inp.command}`);
}
/** The log of repeat k: walk writes one per repeat, the others one in all. */
export const logName = (command, k) => (command === 'walk' ? `walk-r${k}.log` : command === 'eval-scripted' ? 'eval.log' : `${command}.log`);

/** #1970 A2: the runner's own logical CPUs grouped into physical cores (`siblingsOf(cpu)`: that CPU's SMT siblings); the
 *  first two cores for the world under test, the other two for the load generator. Exactly four cores, else refused. */
export function splitCores(own, siblingsOf) {
  const cores = new Map();
  for (const c of own) { const k = siblingsOf(c).filter((x) => own.includes(x)).sort((a, b) => a - b).join(',') || String(c); cores.set(k, k.split(',').map(Number)); }
  const byFirst = [...cores.values()].sort((a, b) => a[0] - b[0]);
  if (byFirst.length !== 4) throw new Error(`the runner has ${byFirst.length} physical core(s) of its own; the world/load split needs 4`);
  return { physicalCores: 4, world: byFirst.slice(0, 2).flat().join(','), load: byFirst.slice(2).flat().join(',') };
}
/** [[pid, ppid], …] → every descendant pid of root. */
export function descendants(table, root) {
  const kids = new Map(); for (const [p, pp] of table) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  const out = [], q = [root]; while (q.length) for (const k of kids.get(q.shift()) ?? []) { out.push(k); q.push(k); }
  return out;
}
/** A world server process (a direct boot, or a child of the launcher), by its NUL-separated command line. */
export const isWorld = (cmdline) => cmdline.split('\0').some((a) => a.endsWith('apps/server/src/main.ts'));

/** "0-3,8,10-11" → [0,1,2,3,8,10,11]. */
export function parseCpuList(s) {
  return String(s).trim().split(',').filter(Boolean).flatMap((r) => { const [a, b = a] = r.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, k) => a + k); });
}
/** /proc/stat text → { cpu index: [busy, total] } jiffies. */
export function parseProcStat(text) {
  const o = {};
  for (const l of text.split('\n')) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(l); if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number), idle = v[3] + (v[4] ?? 0), total = v.slice(0, 8).reduce((s, x) => s + x, 0);
    o[m[1]] = [total - idle, total];
  }
  return o;
}
/** Busy fraction per core between two /proc/stat samples; the runner's own cores and the whole machine. */
export function loadFacts(a, b, own, gate = LOAD_GATE) {
  const busy = (c) => { const d = b[c][1] - a[c][1]; return d > 0 ? (b[c][0] - a[c][0]) / d : 0; };
  const all = Object.keys(b).filter((c) => a[c]).map(Number), r3 = (x) => +x.toFixed(3), mean = (cs) => (cs.length ? r3(cs.reduce((s, c) => s + busy(c), 0) / cs.length) : null);
  const mine = own.filter((c) => all.includes(c));
  const ownMean = mean(mine);
  return { ownCores: mine.length, ownBusy: ownMean, ownBusyMax: mine.length ? r3(Math.max(...mine.map(busy))) : null, machineCores: all.length, machineBusy: mean(all), gate, overGate: ownMean == null || ownMean > gate };
}

/** Soul tokens anywhere under out (each `.eden-agent.json`); none may leave the runner. */
export function soulTokens(out) {
  const tokens = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === '.eden-agent.json') { try { const t = JSON.parse(readFileSync(p, 'utf8')).token; if (t) tokens.push(String(t)); } catch { /* no token */ } }
  } };
  if (existsSync(out)) walk(out);
  return tokens;
}
/** Per command, the files a timed run may publish besides timed-run.json: globs relative to out (`*` stays within one
 *  path segment). Soul folders, world data, call logs, traces and CPU profiles stay on the runner. */
export const PUBLISH = {
  walk: [1, 2, 3].map((k) => `walk-r${k}.log`),
  'eval-scripted': ['eval/result.json', 'eval/REPORT.md', 'eval.log'],
  'eval-load': ['eval-load/load-result.json', 'eval-load/LOAD.md', 'eval-load.log'],
  // #2164 measurement branch only: the launcher's log and the world's own log (exits, wedges, holds), scrubbed
  'bench-client': ['bench/receipt.json', 'bench/REPORT.md', 'bench/*/result.json', 'bench-client.log', 'bench/*/launcher.log', 'bench/*/launcher/logs/*'],
  meetup: ['meetup/summary.json', 'meetup/VERDICT.md', 'meetup/*/receipt.json', 'meetup/*/result.json', 'meetup/*/REPORT.md', 'meetup.log'],
  'slopes-profile': ['slopes/receipt.json', 'slopes/results.json', 'slopes/REPORT.md', 'slopes/*/result.json', 'slopes-profile.log'],
};
const filesUnder = (d, base = d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return []; } return es.flatMap((e) => (e.isDirectory() ? filesUnder(join(d, e.name), base) : e.isFile() ? [join(d, e.name).slice(base.length + 1).split(sep).join('/')] : [])); };
/** The files a timed run of `command` may publish that exist, relative to out, in PUBLISH order. */
export function allowlist(out, command) {
  const all = filesUnder(out).sort();
  return ['timed-run.json', ...PUBLISH[command]].flatMap((g) => { const t = globTest(g); return all.filter((f) => t(f)); });
}

/** Copy the allowlisted files into dest, scrubbed; refuse if any still holds a Soul token. Returns the copied list. */
export function stage({ out, dest, command, scrubWith }) {
  const tokens = soulTokens(out), texts = allowlist(out, command).map((f) => [f, scrub(readFileSync(join(out, f), 'utf8'), scrubWith)]);
  // #2164 measurement branch only: a log that holds a Soul token is withheld (not uploaded); any other file still refuses all
  const isLog = (f) => /\/launcher(\.log|\/logs\/)/.test(f), held = texts.filter(([f, t]) => isLog(f) && tokens.some((k) => t.includes(k))).map(([f]) => f);
  for (const f of held) console.log(`withheld ${f}: it holds a Soul token`);
  for (const [f, t] of texts) if (!held.includes(f) && tokens.some((k) => t.includes(k))) throw new Error(`${f} holds a Soul token; nothing is uploaded`);
  for (const [f, t] of texts.filter(([f]) => !held.includes(f))) { mkdirSync(join(dest, f, '..'), { recursive: true }); writeFileSync(join(dest, f), t); }
  return texts.map(([f]) => f).filter((f) => !held.includes(f));
}

/** A whole-path glob where `*` matches within one path segment → a test. */
export const globTest = (g) => { const re = new RegExp(`^${g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`); return (p) => re.test(p); };

/** The entries of `uid` under roots (files and directories, links not followed), skipping allowed dirs, any runner
 *  install (a dir holding `.runner`) and excluded globs. Another account's entries are never listed or entered. */
export function snapshot(roots, { allow = [], exclude = [], uid = null } = {}) {
  const skip = allow.filter(Boolean).map((d) => resolve(d)), ex = exclude.filter(Boolean).map(globTest), found = [];
  const out = (p) => skip.some((d) => p === d || p.startsWith(d + sep)) || ex.some((t) => t(p));
  const walk = (d) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name); if (out(p)) continue;
      let st; try { st = lstatSync(p); } catch { continue; }
      if (uid != null && st.uid !== uid) continue;
      if (st.isDirectory() && existsSync(join(p, '.runner'))) continue;   // a runner install
      found.push(p); if (st.isDirectory()) walk(p);
    }
  };
  for (const r of roots) if (r && existsSync(r) && !out(resolve(r))) walk(resolve(r));
  return found.sort();
}
/** Entries in `after` that were not in the start snapshot `before`. */
export const newEntries = (before, after) => { const b = new Set(before); return after.filter((p) => !b.has(p)); };

// ------------------------------------------------------------------ impure side (the workflow's steps)
const output = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? null : process.argv[i + 1]; };
const readJ = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ownCpus = () => { const m = /^Cpus_allowed_list:\s*(\S+)/m.exec(readFileSync('/proc/self/status', 'utf8')); if (!m) throw new Error('cannot read this process\'s CPU affinity'); return parseCpuList(m[1]); };
const portFree = (p) => new Promise((r) => { const s = createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
/** A base port with `span` consecutive free ports, drawn at random so runs beside each other on one machine rarely collide. */
async function freePorts(span) {
  for (let t = 0; t < 100; t++) { const b = 20000 + Math.floor(Math.random() * 30000); let ok = true; for (let k = 0; k < span && ok; k++) ok = await portFree(b + k); if (ok) return b; }
  throw new Error(`no ${span} consecutive free ports`);
}
const siblingsOf = (c) => { try { return parseCpuList(readFileSync(`/sys/devices/system/cpu/cpu${c}/topology/thread_siblings_list`, 'utf8')); } catch { return [c]; } };
const procTable = () => readdirSync('/proc').filter((d) => /^\d+$/.test(d)).flatMap((d) => { try { return [[Number(d), Number(readFileSync(`/proc/${d}/stat`, 'utf8').split(') ').at(-1).split(' ')[1])]]; } catch { return []; } });
const allowedOf = (pid) => { try { return /^Cpus_allowed_list:\s*(\S+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? null; } catch { return null; } };
/** #1970 A2: each world process under root, with all its threads, onto the world's cores as soon as it appears (threads
 *  made later inherit the mask). Returns what was pinned: a count and the allowed lists read back, no pids. */
function pinWorlds(root, cpus) {
  const pinned = new Map(), tick = () => {
    for (const pid of descendants(procTable(), root)) {
      if (pinned.has(pid)) continue;
      let cmd; try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      if (!isWorld(cmd)) continue;
      try { execFileSync('taskset', ['-a', '-p', '-c', cpus, String(pid)], { stdio: 'ignore' }); pinned.set(pid, allowedOf(pid)); } catch { /* exited */ }
    }
  };
  const iv = setInterval(tick, 250);
  return { stop: () => { clearInterval(iv); return { worldProcesses: pinned.size, worldAllowed: [...new Set(pinned.values())] }; } };
}
const scrubWith = () => { const env = process.env, u = (() => { try { return userInfo().username; } catch { return env.USER; } })();
  return { paths: [[env.PER_RUN, '<per-run>'], [env.GITHUB_WORKSPACE, '.'], [env.RUNNER_WORKSPACE, '<runner-work>'], [env.RUNNER_TEMP, '<runner-temp>'], [env.HOME, '~']], names: [[hostname(), '<host>'], [u, '<user>']] }; };

async function main(cmd) {
  if (cmd === 'snapshot' || cmd === 'strays') {   // A2: entries of the shared home and /tmp new since the job's start
    // Skipped: the runner installs (a dir holding `.runner`: the service's _work, _temp, _tool and _diag, with every
    // job's per-run directory and checkout), the tool cache, and the --exclude globs the workflow names with reasons.
    // Only this account's entries are read, so no other account's path can reach the log.
    const env = process.env, runnerRoot = env.RUNNER_WORKSPACE ? resolve(env.RUNNER_WORKSPACE, '../..') : null, file = arg('snapshot');
    const now = snapshot([env.HOME, '/tmp'], { allow: [env.RUNNER_TOOL_CACHE, runnerRoot], exclude: (arg('exclude') ?? '').split(','), uid: process.getuid?.() ?? null });
    if (cmd === 'snapshot') { writeFileSync(file, JSON.stringify(now)); console.log(`snapshot: ${now.length} entries`); return; }
    const found = newEntries(JSON.parse(readFileSync(file, 'utf8')), now), sw = scrubWith();
    for (const f of found.slice(0, 50)) console.log(`::error::written outside the per-run directory: ${scrub(f, sw)}`);
    if (found.length) throw new Error(`${found.length} entries written outside the per-run directory`);
    console.log('no entries written outside the per-run directory'); return;
  }
  const inp = parseInputs(process.env), rf = arg('record');
  if (cmd === 'inputs') { output('target', checkoutRef(inp.ref)); console.log(`inputs ok: ${inp.ref}, ${inp.command} x${inp.repeats}${inp.args.length ? ` ${inp.args.join(' ')}` : ''}`); return; }
  if (cmd === 'load') {   // A3: own cores and whole machine; wait a bounded time for own cores to settle, else refuse
    const own = ownCpus(), stat = () => parseProcStat(readFileSync('/proc/stat', 'utf8'));
    let f;
    for (let t = 0; ; t += 15) {
      const a = stat(); await sleep(SAMPLE_S * 1000); f = loadFacts(a, stat(), own);
      if (!f.overGate || t >= SETTLE_WAIT_S) break;
      console.log(`own cores busy ${f.ownBusy} above the gate ${LOAD_GATE}; waiting`); await sleep(15_000);
    }
    const startLoad = { ...f, sampleS: SAMPLE_S, machineLoad1PerCore: +(loadavg()[0] / f.machineCores).toFixed(3) };
    writeFileSync(rf, JSON.stringify({ schema: 'timed-run/1', workflowRun: process.env.GITHUB_RUN_ID, ref: inp.ref, commit: process.env.REF_COMMIT ?? null, inputs: inp, startLoad }, null, 1));
    console.log(`start load: own ${f.ownCores} cores busy ${f.ownBusy} (max ${f.ownBusyMax}), machine ${f.machineCores} cores busy ${f.machineBusy}, 1-min load per core ${startLoad.machineLoad1PerCore}`);
    if (f.overGate) throw new Error(`the runner's own cores stayed above the gate (${f.ownBusy} > ${LOAD_GATE}) for ${SETTLE_WAIT_S} s; the run does not start`);
    return;
  }
  if (cmd === 'run') {   // fake minds, no GitHub token
    const rec = readJ(rf), out = resolve(arg('out')), env = { ...process.env, BRAIN_MODE: 'fake' }; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
    if (!rec.startLoad || rec.startLoad.overGate) throw new Error('no passing start-load record; the run does not start');
    mkdirSync(out, { recursive: true });
    // #1970: the world on two physical cores, the load generator (the driver and all it starts but the world) on the other
    // two. HOME goes inside the per-run directory: the capacity bench moves finished world data under ~/.Trash.
    const split = SPLIT.includes(inp.command) ? splitCores(ownCpus(), siblingsOf) : null;
    if (split) {
      execFileSync('taskset', ['-V'], { stdio: 'ignore' });
      env.HOME = join(env.PER_RUN, 'home'); mkdirSync(env.HOME, { recursive: true });
      console.log(`cores: world ${split.world}, load generator ${split.load}`);
    }
    const n = inp.command === 'walk' ? inp.repeats : 1, runs = [];
    for (let k = 1; k <= n; k++) {
      const argv = commandLine(inp, { out, port: await freePorts(PORT_SPAN[inp.command]) }), log = join(out, logName(inp.command, k)), t0 = Date.now();
      console.log(`${inp.command} ${k}/${n}: ${argv.join(' ')}`);
      const [bin, args] = split ? ['taskset', ['-c', split.load, process.execPath, ...argv]] : [process.execPath, argv];
      const ws = createWriteStream(log), child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }), pins = split ? pinWorlds(child.pid, split.world) : null;
      for (const s of [child.stdout, child.stderr]) s.on('data', (b) => { ws.write(b); process.stdout.write(b); });
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
      const code = await new Promise((r) => child.on('close', (c) => r(c ?? 1))); ws.end();
      runs.push({ repeat: k, exitCode: code, wallMs: Date.now() - t0, ...(pins ? { cpuSplit: { ...split, ...pins.stop() } } : {}) });
    }
    writeFileSync(join(out, 'timed-run.json'), JSON.stringify({ ...rec, runs }, null, 1));
    const failed = runs.filter((r) => r.exitCode !== 0);
    if (failed.length) throw new Error(`${failed.length} of ${runs.length} run(s) exited non-zero`);
    if (runs.some((r) => r.cpuSplit && !r.cpuSplit.worldProcesses)) throw new Error('no world process was seen to pin to the world\'s cores');
    return;
  }
  if (cmd === 'stage') {
    const out = resolve(arg('out')); mkdirSync(out, { recursive: true });
    if (!existsSync(join(out, 'timed-run.json')) && existsSync(rf)) writeFileSync(join(out, 'timed-run.json'), readFileSync(rf));
    const copied = stage({ out, dest: arg('dest'), command: inp.command, scrubWith: scrubWith() });
    console.log(`staged ${copied.length} file(s): ${copied.join(', ')}`); return;
  }
  throw new Error(`unknown command ${cmd}: inputs | load | run | stage | snapshot | strays`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv[2]).catch((e) => { console.log(`::error::${e.code ? `${e.syscall ?? 'file'} failed: ${e.code} (path withheld)` : e.message}`); process.exit(1); });
