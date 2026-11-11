#!/usr/bin/env node
// The release's browser checks on a GPU workstation (#1438): the release probe across the activation, then the stranger
// walks, the phone poster and the phone stall, with exactly ship.sh's commands and checks.mjs's bars. release.yml runs
// everything else (ship.sh --no-eyes on a GitHub runner, which has no GPU: its SwiftShader WebGL cannot hold these bars).
// Plain HTTPS against the public origin plus the GitHub API through `gh`; no ssh, no host. Start it right after the dispatch:
//
//   gh workflow run release.yml --ref main -f version=<v> [-f dry_run=false]
//   node tools/world-launcher/deploy/ship/eyes.mjs --sha <the dispatched head, 40 hex> [--run <run id>] [--label <v>]
//        [--origin https://soul.game] [--cli .local/release-probe] [--out .local/ship/<label>-eyes] [--find-min 45]
//
// Handover (ship/handover.mjs): it waits for the run's release/ship "waiting-for-eyes" status on that sha, refuses a run
// whose head is not --sha, starts the probe (expecting we-<sha12>, or the live build for a no-switch run), posts
// release/eyes "ready", waits for release/ship "released", lets the probe watch 60 s more, runs the checks and posts
// release/eyes pass or fail. Any failure, interrupt or crash posts fail, never pass; the run then fails and does not publish.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTEXT, defaultRepo, description, isRun, isSha, latestFor, listStatuses, postStatus, sameRun, waitFor } from './handover.mjs';

// EYES_DEPLOY_DIR: tests only, a deploy/ folder of stand-in tools (release-probe.mjs, ship/*.mjs, ship/poster-count.py)
const HERE = dirname(fileURLToPath(import.meta.url)), DEPLOY = process.env.EYES_DEPLOY_DIR || resolve(HERE, '..'), ROOT = resolve(HERE, '../../../..');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const sha = flag('sha'), wantRun = flag('run', null), repo = flag('repo', defaultRepo());
const origin = (flag('origin', 'https://soul.game')).replace(/\/$/, '');
const cli = resolve(flag('cli', join(ROOT, '.local/release-probe')));
// release-min: from ready to the activation; the job's snapshot, stage, rehearsal and backup all run in it
const findMin = Number(flag('find-min', 45)), releaseMin = Number(flag('release-min', 60)), pollMs = Number(flag('poll-s', 15)) * 1000;
const PAGE = '/w/eden/', SLUGS = ['eden', 'mars-college-2026', 'mars-college-2027'];
const say = (s) => console.log(`[eyes ${new Date().toISOString().slice(11, 19)}Z] ${s}`);
if (!isSha(sha)) { console.error('eyes: --sha must be the full 40-hex commit the dispatched run ships'); process.exit(2); }
if (wantRun != null && !isRun(wantRun)) { console.error('eyes: --run is the Actions run id (digits, optionally .<attempt>)'); process.exit(2); }
if (!existsSync(join(cli, '.eden-god.json'))) { console.error(`eyes: no release-probe god folder at ${cli} (--cli; docs/release.md "The release-probe world")`); process.exit(2); }

const gh = (args) => new Promise((yes, no) => { const p = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] }); let o = '', e = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => (c ? no(Error(e.trim().slice(0, 300))) : yes(o))); });
/** run a tool to a log file; resolves its exit code */
const tool = (log, cmd, args, env = {}) => new Promise((yes) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let buf = '';
  p.stdout.on('data', (d) => (buf += d)); p.stderr.on('data', (d) => (buf += d));
  p.on('close', (c) => { writeFileSync(log, buf); yes(c ?? 1); }); p.on('error', () => yes(127));
});

const runUrl = () => `https://github.com/${repo}/actions/runs/${String(run).split('.')[0]}`;
let run = null, posted = false, probe = null, PDIR = null, probeExit = null, aborting = false;
async function finish(state, word, detail) {
  if (posted || !run) return; posted = true;
  try { const d = description(run, word, { detail }); await postStatus(repo, sha, CONTEXT.eyes, state, d, runUrl()); say(`posted ${CONTEXT.eyes} ${state}: ${d}`); }
  catch (e) { say(`COULD NOT POST ${CONTEXT.eyes} ${state} (${e.message}); the run waits and then fails closed`); }
}
async function abort(why, code = 1) {
  if (aborting) return; aborting = true;
  say(`STOPPED: ${why}`);
  await finish('failure', 'fail', why);
  // the probe removes its own edits from the release-probe world when told to stop: let it, within 4 min
  if (probe && PDIR) {
    writeFileSync(join(PDIR, 'stop'), ''); say('waiting for the probe to clean up its edits');
    await Promise.race([probeExit, new Promise((r) => setTimeout(r, 240_000))]);
    probe?.kill('SIGTERM');
  }
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => abort(`interrupted (${sig})`, 130));
// the message stays in this log: it can carry local paths, which never go into a public status
const crashed = (e) => { say(`crash: ${e?.stack ?? e}`); return abort(`eyes crashed${/^[A-Z][A-Z0-9_]+$/.test(e?.code ?? '') ? ` (${e.code})` : ''}`); };
process.on('uncaughtException', crashed); process.on('unhandledRejection', crashed);

// 1. the run: the newest release/ship "waiting-for-eyes" on this sha whose run is release.yml, in progress, shipping this
// sha, at the attempt the status names. An earlier run's or attempt's status is skipped; another sha refuses (exit 2).
say(`looking for a release run of ${sha.slice(0, 12)}${wantRun ? ` (run ${wantRun})` : ''}; up to ${findMin} min`);
let mode = null; const skipped = new Set(), findEnd = Date.now() + findMin * 60_000;
for (;;) {
  let statuses = []; try { statuses = await listStatuses(repo, sha); } catch (e) { say(`status read failed; retrying`); }
  const waiting = statuses.filter((x) => x.context === CONTEXT.ship && x.state === 'pending').map((x) => latestFor([x], CONTEXT.ship, wantRun)).filter((x) => x?.word === 'waiting-for-eyes' && !skipped.has(x.run));
  const cand = waiting[0];
  if (cand && latestFor(statuses, CONTEXT.ship, cand.run)?.word === 'waiting-for-eyes') {
    const [id, attempt] = cand.run.split('.');
    const info = JSON.parse(await gh(['api', `repos/${repo}/actions/runs/${id}`]));
    if (info.head_sha !== sha || !/\.github\/workflows\/release\.yml$/.test(info.path ?? '')) {
      say(`REFUSED: run ${id} is ${info.path} at ${String(info.head_sha).slice(0, 12)}, not release.yml shipping ${sha.slice(0, 12)}`); process.exit(2);
    }
    if (info.status !== 'completed' && (attempt === undefined || String(info.run_attempt) === attempt)) { run = cand.run; mode = cand.mode; break; }
    say(`run ${cand.run} is not the live attempt (${info.status}, attempt ${info.run_attempt}); still looking`); skipped.add(cand.run);
  } else if (cand) skipped.add(cand.run);
  if (Date.now() + pollMs * 2 > findEnd) { say('no release run is waiting for eyes on this sha'); process.exit(1); }
  await new Promise((r) => setTimeout(r, pollMs * 2));
}
const label = flag('label', `run-${String(run).replace('.', '-')}`);
const OUT = resolve(flag('out', join(ROOT, `.local/ship/${label}-eyes`))); PDIR = join(OUT, 'probe');
if (existsSync(join(OUT, 'eyes-result.json'))) { const was = `${OUT}.${Date.now()}`; renameSync(OUT, was); say(`an earlier eyes run moved to ${was}`); }
mkdirSync(OUT, { recursive: true });
say(`run ${run}, mode ${mode}, outputs ${OUT}`);

// 2. the probe, expecting the candidate (or, when nothing switches, the build that stays live)
let expect = `we-${sha.slice(0, 12)}`;
if (mode === 'no-switch') {
  const h = await fetch(`${origin}/__sim/healthz`).then((r) => r.json()).catch(() => null);
  if (!/^we-[0-9a-f]{12}$/.test(h?.build ?? '')) await abort('healthz does not name the live build');
  expect = h.build;
}
const env = { SHIP_PLAYWRIGHT_FROM: join(ROOT, 'mars/viewer'), EDEN_GOD_PLAYWRIGHT_FROM: join(ROOT, 'mars/viewer'), EDEN_GOD_NO_NPX: '1',
  SIM_CHROME_LEASE: join(ROOT, 'tools/god-skill/lib/chrome-lease.mjs'), CHROME_LEASE_SLOTS: process.env.CHROME_LEASE_SLOTS || '3' };
for (const k of ['SIM_HEAVY_SLOT', 'EDEN_GOD_NO_LEASE', 'PHONE', 'WIN', 'CPU', 'DESK']) delete process.env[k];
const probeArgs = [join(DEPLOY, 'release-probe.mjs'), '--origin', origin, '--pages', PAGE, '--phone-pages', PAGE, '--expect-build', expect, '--out', PDIR,
  '--after-s', '60', '--settle-s', '20', '--arrive-every', '6', '--cli-every', '1', '--cli', cli, '--max-min', String(releaseMin + 20)];
say(`probe expecting ${expect}`);
let probeLog = ''; probeExit = new Promise((yes) => {
  probe = spawn(process.execPath, probeArgs, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  probe.stdout.on('data', (d) => (probeLog += d)); probe.stderr.on('data', (d) => (probeLog += d));
  probe.on('close', (c) => { writeFileSync(join(OUT, 'probe.log'), probeLog); probe = null; yes(c ?? 1); });
});
for (let i = 0; !existsSync(join(PDIR, 'ready')); i++) {
  if (!probe) await abort('the probe exited before it was ready (probe.log)');
  if (i > 600) await abort('the probe was not ready in 600 s');
  await new Promise((r) => setTimeout(r, 1000));
}
if (aborting) await new Promise(() => {});   // an abort is under way: it posts the failure and exits
await postStatus(repo, sha, CONTEXT.eyes, 'pending', description(run, 'ready'), runUrl());
say('probe ready; posted release/eyes ready; waiting for the activation');

// 3. the release: release/ship "released" (activated, or the no-switch skip); a stop before it fails eyes without walks
// "ready" means watching now: while waiting, the probe's exit fails eyes at once, and ready is re-posted every heartbeat so the
// job's pre-activation check (--max-age-s) refuses a ready that a dead probe or a sleeping workstation left behind
const heartbeatMs = Number(flag('heartbeat-s', 60)) * 1000;
let probeGone = false; probeExit.then(() => { probeGone = true; });
const relEnd = Date.now() + releaseMin * 60_000; let lastBeat = Date.now(), rel = null;
for (;;) {
  if (probeGone) await abort('the probe exited before the release');
  let st = null; try { st = latestFor(await listStatuses(repo, sha), CONTEXT.ship, run); } catch (e) { say('status read failed; retrying'); }
  if (st && (st.state === 'failure' || st.state === 'error')) await abort(`ship stopped before the release (${st.detail || st.description})`);
  if (st?.state === 'success' && st.word === 'released') { rel = st; break; }
  if (probeGone) await abort('the probe exited before the release');
  if (Date.now() > relEnd) await abort(`no release within ${releaseMin} min`);
  if (!aborting && Date.now() - lastBeat >= heartbeatMs) {
    try { await postStatus(repo, sha, CONTEXT.eyes, 'pending', description(run, 'ready'), runUrl(), { tries: 1 }); lastBeat = Date.now(); } catch (e) { say('ready heartbeat failed; retrying next poll'); }
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
if (probeGone) await abort('the probe exited before the release');
writeFileSync(join(PDIR, 'released'), ''); say('released; the probe watches 60 s more');

// 4. the checks: ship.sh's commands, checks.mjs's bars
const failed = [], post = [];
const rc = await probeExit; post.push(`probe ${rc}`);
// the bar alone (counts, page paths, build ids): what failed, readable without the workstation's files
let bar = null; try { bar = JSON.parse(readFileSync(join(PDIR, 'report.json'), 'utf8')).bar; writeFileSync(join(OUT, 'probe-bar.json'), JSON.stringify(bar, null, 1) + '\n'); } catch {}
const missed = !bar ? ['no-report'] : [['errorPages', bar.errorPages], ['notLoaded', bar.notLoaded?.length], ['noBuild', bar.noBuild?.length], ['arrivalsNotLoaded', bar.arrivalsNotLoaded?.length],
  ['lost', bar.lost], ['unclean', bar.unclean], ['notResumed', bar.notResumed], ['reloaded', bar.reloaded?.length], ['rolledBack', bar.rolledBack?.length]].filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`)
  .concat(bar.reconnectMaxMs > (bar.reconnectBarMs ?? 5000) ? [`reconnectMaxMs=${bar.reconnectMaxMs}`] : []);
if (rc !== 0) failed.push(`probe(${missed.join(',') || `exit=${rc}`})`);
const live = async (name, log, cmd, args, more = {}) => { const c = await tool(join(OUT, log), cmd, args, { ...env, ...more }); post.push(`${name} ${c}`); if (c) failed.push(name); say(`${name}: ${c ? `FAILED (exit ${c})` : 'ok'}`); };
const N = process.execPath, SHIPD = join(DEPLOY, 'ship'), URLS = SLUGS.map((s) => `${origin}/w/${s}/`);
await live('walk-desktop', 'walk-desktop.log', N, [join(SHIPD, 'walk.mjs'), join(OUT, 'walk-desktop'), ...URLS], { DPRS: '1,2' });
await live('walk-phone', 'walk-phone.log', N, [join(SHIPD, 'walk.mjs'), join(OUT, 'walk-phone'), ...URLS], { PHONE: '1', DPRS: '1,2' });
await live('walks-verdict', 'walks-check.txt', N, [join(SHIPD, 'checks.mjs'), 'walks', String(URLS.length * 4), join(OUT, 'walk-desktop/walk.json'), join(OUT, 'walk-phone/walk.json')]);
mkdirSync(join(OUT, 'poster'), { recursive: true });
await live('poster-capture', 'poster.log', N, [join(SHIPD, 'poster.mjs'), join(OUT, 'poster'), origin + PAGE, '3']);
await live('poster-classify', 'poster-count.txt', 'python3', [join(SHIPD, 'poster-count.py'), join(OUT, 'poster')]);
await live('poster-verdict', 'poster-check.txt', N, [join(SHIPD, 'checks.mjs'), 'poster', join(OUT, 'poster.log'), join(OUT, 'poster-count.txt'), '3']);
mkdirSync(join(OUT, 'stall'), { recursive: true });
await live('stall-capture', 'stall.log', N, [join(SHIPD, 'stall.mjs'), origin + PAGE, '4', join(OUT, 'stall')]);
await live('stall-verdict', 'stall-check.txt', N, [join(SHIPD, 'checks.mjs'), 'stall', join(OUT, 'stall.log'), '4']);

// 5. the verdict
writeFileSync(join(OUT, 'POSTLIVE.txt'), post.join('\n') + '\n');
writeFileSync(join(OUT, 'eyes-result.json'), JSON.stringify({ at: new Date().toISOString(), run, sha, mode, expect, status: failed.length ? 'fail' : 'pass', failed }) + '\n');
for (const f of ['walks-check.txt', 'poster-check.txt', 'stall-check.txt']) if (existsSync(join(OUT, f))) say(`${f}: ${readFileSync(join(OUT, f), 'utf8').trim().split('\n').pop()}`);
if (failed.length) { await finish('failure', 'fail', failed.join(' ')); say(`FAIL: ${failed.join(' ')} (${OUT}/POSTLIVE.txt)`); process.exit(1); }
await finish('success', 'pass'); say('PASS: probe, walks, poster and stall'); process.exit(0);
