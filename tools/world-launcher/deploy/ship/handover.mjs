#!/usr/bin/env node
// The release handover between release.yml (stage, rehearse, backup, activate, healthz, cdn-walk on a GitHub runner) and
// ship/eyes.mjs (the probe, walks, poster and stall on a GPU workstation; #1438). They speak only through commit statuses on
// the release sha, each description carrying the Actions run id and attempt it belongs to (<id>.<attempt>: a re-run keeps
// the id), so a status from an earlier run or attempt is never read as this one's:
//   release/ship  pending  "run=<id> mode=<ship|no-switch> waiting-for-eyes"   the job is about to run ship.sh --no-eyes
//   release/eyes  pending  "run=<id> ready"                                    the probe is watching
//   release/ship  success  "run=<id> released"                                 activated (or its no-switch skip)
//   release/ship  failure  "run=<id> stopped: <why>"                           ship.sh stopped before the release
//   release/eyes  success  "run=<id> pass"   |  failure "run=<id> fail: <checks>"
//
//   node handover.mjs post <sha> <context> <state> <description> [--repo o/r] [--url <target>]
//   node handover.mjs wait <sha> <context> --run <id> --want <ready|final|waiting|released> [--timeout-min 15] [--every-s 30] [--repo o/r]
//     prints the matching status's state and description; exit 0 when it is the one wanted, 1 on failure or timeout (fail closed)
//     --timeout-min 0 reads once: the newest status must already be the wanted one (ship.sh's pre-activation check)
// Descriptions are public: details are reduced to [A-Za-z0-9 ()=.,:_-], so no path, address or stack trace is posted.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CONTEXT = { ship: 'release/ship', eyes: 'release/eyes' };
const MAX_DESC = 140;   // GitHub's limit for a status description

/** "run=123 mode=ship waiting-for-eyes" -> { run: '123', mode: 'ship', word: 'waiting-for-eyes', detail }; null if not ours */
export function parseDescription(d) {
  const m = /^run=(\d+(?:\.\d+)?)(?: mode=(ship|no-switch))? ([a-z-]+)(?::\s*(.*))?$/.exec(String(d ?? '').trim());
  return m ? { run: m[1], mode: m[2] ?? null, word: m[3], detail: m[4] ?? '' } : null;
}

export const safeDetail = (s) => String(s ?? '').replace(/[^A-Za-z0-9 ()=.,:_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
export const isRun = (r) => /^\d+(?:\.\d+)?$/.test(String(r ?? ''));
/** a status's run matches the wanted one: "<id>.<attempt>" exactly, or a bare "<id>" any attempt of it */
export const sameRun = (have, want) => want == null || (String(want).includes('.') ? have === String(want) : have.split('.')[0] === String(want));

export function description(run, word, { mode, detail } = {}) {
  if (!isRun(run)) throw Error(`run must be <id> or <id>.<attempt> (got ${run})`);
  const d = `run=${run}${mode ? ` mode=${mode}` : ''} ${word}${detail ? `: ${safeDetail(detail)}` : ''}`;
  return d.length > MAX_DESC ? `${d.slice(0, MAX_DESC - 1)}…` : d;
}

/** The newest status of <context> that belongs to <run> (the API lists newest first). Another run's statuses never count. */
export function latestFor(statuses, context, run) {
  for (const s of statuses ?? []) {
    if (s.context !== context) continue;
    const p = parseDescription(s.description);
    if (p && sameRun(p.run, run)) return { state: s.state, ...p, description: s.description };
  }
  return null;
}

/** What a waiter makes of the newest matching status: 'yes' (wanted), 'no' (a definite failure: stop), 'wait'. */
export function judge(s, want) {
  if (!s) return 'wait';
  if (s.state === 'failure' || s.state === 'error') return 'no';
  switch (want) {
    case 'waiting': return s.state === 'pending' && s.word === 'waiting-for-eyes' ? 'yes' : 'wait';
    case 'ready': return s.state === 'pending' && s.word === 'ready' ? 'yes' : s.state === 'success' ? 'no' : 'wait';   // a pass with no ready is not a handover
    case 'released': return s.state === 'success' && s.word === 'released' ? 'yes' : 'wait';
    case 'final': return s.state === 'success' && s.word === 'pass' ? 'yes' : 'wait';
    default: throw Error(`unknown want ${want}`);
  }
}

const gh = (args) => new Promise((yes, no) => execFile('gh', args, { maxBuffer: 16 << 20 }, (err, stdout, stderr) => err ? no(Error(`gh ${args[0]} ${args[1] ?? ''}: ${String(stderr).trim().slice(0, 300)}`)) : yes(stdout)));

export async function listStatuses(repo, sha) {
  return JSON.parse(await gh(['api', `repos/${repo}/commits/${sha}/statuses?per_page=100`]));
}

export async function postStatus(repo, sha, context, state, desc, url, { tries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const args = ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${desc}`, '--silent'];
  if (url) args.push('-f', `target_url=${url}`);
  for (let i = 1; ; i++) { try { return await gh(args); } catch (e) { if (i >= tries) throw e; await sleep(10_000 * i); } }
}

/** Poll until the wanted status appears; a failure status or the timeout ends it. A failed API read is retried (5 min back-off on 403). */
export async function waitFor({ repo, sha, context, run, want, timeoutMs, everyMs = 30_000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), list = listStatuses, log = () => {} }) {
  const end = now() + timeoutMs; let last = null;
  for (;;) {
    let wait = everyMs;
    try { last = latestFor(await list(repo, sha), context, run); const j = judge(last, want); if (j !== 'wait') return { ok: j === 'yes', status: last }; }
    catch (e) { log(`status read failed: ${e.message}`); if (/403|rate limit/i.test(e.message)) wait = Math.max(everyMs, 300_000); }
    if (timeoutMs <= 0 || now() + wait > end) return { ok: false, status: last, timedOut: true };
    await sleep(wait);
  }
}

export const isSha = (s) => /^[0-9a-f]{40}$/.test(String(s ?? ''));
export const defaultRepo = () => process.env.GITHUB_REPOSITORY || 'soulsimulation/souls';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, sha, context, ...rest] = process.argv.slice(2);
  const flag = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
  const repo = flag('repo', defaultRepo());
  if (!isSha(sha) || !Object.values(CONTEXT).includes(context)) { console.error('usage: handover.mjs post|wait <40-hex sha> release/ship|release/eyes …'); process.exit(2); }
  if (cmd === 'post') {
    const [state, desc] = rest;
    if (!['pending', 'success', 'failure'].includes(state) || !parseDescription(desc)) { console.error('post: state pending|success|failure and a "run=<id> …" description'); process.exit(2); }
    await postStatus(repo, sha, context, state, desc, flag('url'));
    console.log(`${context} ${state}: ${desc}`);
  } else if (cmd === 'wait') {
    const run = flag('run'), want = flag('want');
    if (!isRun(run)) { console.error('wait: --run <id>[.<attempt>]'); process.exit(2); }
    const r = await waitFor({ repo, sha, context, run, want, timeoutMs: Number(flag('timeout-min', 15)) * 60_000, everyMs: Number(flag('every-s', 30)) * 1000, log: (m) => console.log(m) });
    console.log(r.status ? `${context} ${r.status.state}: ${r.status.description}` : `${context}: no status for run ${run}`);
    if (r.timedOut) console.log(`timed out waiting for ${want}`);
    process.exit(r.ok ? 0 : 1);
  } else { console.error('usage: handover.mjs post|wait …'); process.exit(2); }
}
