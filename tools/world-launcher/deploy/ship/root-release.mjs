#!/usr/bin/env node
// Verdicts for ship.sh's root-only release: the receipts, the host snapshot and its drift, the row-verified backup and
// the activation preconditions. Each command reads local files, prints what it found and exits 1 with the reason.
//   node root-release.mjs receipts <gate receipt> <ship receipt> <sha>
//   node root-release.mjs receipt <release-receipt.json> <sha>   (the publishable release receipt, ship-receipt.mjs --public)
//   node root-release.mjs accepted <receipts folder> <accepted-exceptions.json> <sha>   (a gate blocked only by accepted exceptions;
//        a folder with release-receipt.json alone is checked from it, as release.yml does)
//   node root-release.mjs snapshot <healthz.json> <remote.json> <label sha> <out.json> [accepted host codes, comma-separated]
//   node root-release.mjs drift <snapshot.json> <healthz.json> <remote.json>
//   node root-release.mjs backup <backup.log> <quick-check.log> <snapshot.json> <label> <out.json>
//   node root-release.mjs activation <snapshot.json> <backup-receipt.json> <upload-receipt.json> <manifest>
//   node root-release.mjs health <healthz.json> <build> <worlds>
//   node root-release.mjs rehearse <rehearse.log> <build> <out.json>   (the host's boot rehearsal of every world, #1402)
//   node root-release.mjs rehearsed <rehearse.json> <build>
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const read = f => JSON.parse(readFileSync(f, 'utf8'));
const digest = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const HOUR_MS = 3_600_000;
export const IDLE_HANDOVERS = [null, undefined, 'done', 'failed', 'rolled-back'];
export const DRIFT_KEYS = ['productionTarget', 'configurationSha256', 'worlds', 'registryIdentitySha256', 'databasePaths', 'databases', 'keeperPid', 'servicePid', 'keeperSha', 'activeBuild', 'deployedKeeperSha'];
export const HEALTH_KEYS = ['ok', 'build', 'worlds', 'hostOk', 'hostCodes', 'auth', 'maxWorlds', 'maxRunning'];

/** A clean gate receipt and ship receipt for exactly this commit (docs/testing/remote-gate.md). */
export function receiptProblems(gate, ship, sha, gateSha256) {
  const out = [];
  if (gate?.refs?.candidate?.sha !== sha) out.push(`gate receipt is for ${gate?.refs?.candidate?.sha}, not this commit`);
  if (gate?.scope?.resolved !== 'full') out.push(`gate scope ${gate?.scope?.resolved} is not the full contract`);
  if (!['pass', 'quarantined'].includes(gate?.status)) out.push(`gate status ${gate?.status}`);
  for (const k of ['blockers', 'newFailures', 'unexpectedSkips', 'removed']) if (gate?.[k]?.length) out.push(`gate has ${gate[k].length} ${k}`);
  if (ship?.candidate !== sha) out.push(`ship receipt is for ${ship?.candidate}, not this commit`);
  if (!['pass', 'quarantined'].includes(ship?.status)) out.push(`ship receipt status ${ship?.status}`);
  if (ship?.blockers?.length) out.push(`ship receipt has ${ship.blockers.length} blockers`);
  if (ship?.newFailures) out.push(`ship receipt has ${ship.newFailures} new failures`);
  if (ship?.gate?.sha256 !== gateSha256) out.push('ship receipt names a different gate receipt');
  return out;
}

/** The boot rehearsal's log (ship/host-rehearse.sh): one JSON line per world and a final REHEARSE line. Every world that
 *  is not approximate must pass; an approximate one is reported. A log without its REHEARSE line never passes. */
export function rehearseReceipt(log, build) {
  const lines = log.split('\n'), worlds = lines.filter(l => l.startsWith('{"slug"')).map(l => JSON.parse(l));
  const done = lines.find(l => l.startsWith('REHEARSE ')), problems = [];
  if (!done) problems.push('the rehearsal did not finish (no REHEARSE line)');
  if (!worlds.length) problems.push('no world was rehearsed');
  else if (done && JSON.parse(done.slice(9)).worlds !== worlds.length) problems.push('the rehearsal log is incomplete');
  for (const w of worlds) if (w.verdict !== 'pass' && w.verdict !== 'approximate') problems.push(`${w.slug}: ${w.flags?.join('; ') || w.verdict}`);
  return { schema: 'ship-rehearse/1', at: new Date().toISOString(), build, status: problems.length ? 'stop' : 'pass', problems,
    worlds: worlds.length, passed: worlds.filter(w => w.verdict === 'pass').length, approximate: worlds.filter(w => w.verdict === 'approximate').map(w => w.slug),
    slow: worlds.filter(w => w.flags?.some(f => f.startsWith('slow'))).map(w => w.slug), results: worlds };
}

/** The publishable release receipt (tools/test-harness/ship-receipt.mjs --public, #1402) for exactly this commit. */
export function releaseReceiptProblems(r, sha) {
  const out = [], g = r?.gate ?? {}, v = r?.v7 ?? {};
  if (r?.schema !== 'release-receipt/1') out.push('not a release receipt (release-receipt/1)');
  if (r?.candidate !== sha) out.push(`release receipt is for ${r?.candidate}, not this commit`);
  if (r?.build !== `we-${sha.slice(0, 12)}`) out.push(`release receipt names build ${r?.build}`);
  if (!['pass', 'quarantined'].includes(r?.status) || r?.blockers !== 0) out.push(`release receipt status ${r?.status}, ${r?.blockers} blockers`);
  if (g.scope !== 'full') out.push(`gate scope ${g.scope} is not the full contract`);
  if (!['pass', 'quarantined'].includes(g.status)) out.push(`gate status ${g.status}`);
  for (const k of ['blockers', 'newFailures', 'unexpectedSkips', 'removed']) if (g[k] !== 0) out.push(`gate has ${g[k]} ${k}`);
  if (!/^[0-9a-f]{64}$/.test(g.sha256 ?? '') || !/^[0-9a-f]{64}$/.test(v.sha256 ?? '')) out.push('release receipt lacks the raw receipts\' sha256');
  if (v.status !== 'pass' || v.dirty !== false || v.source !== sha || !(v.checks > 0) || v.failed !== 0) out.push(`V7 ${v.status}, source ${v.source}, dirty ${v.dirty}, ${v.checks} checks, ${v.failed} failed`);
  return out;
}

/** The gate blockers the maintainer may accept: the receipt list that holds them and the gate's blocker line for it.
 *  New failures, every other gate blocker, a failing V7 and a missing raw receipt hash are never acceptable. */
export const ACCEPTABLE = { removed: 'baseline assertions removed', unexpectedSkips: 'unexpected test skip(s)/TODO(s)' };

/** A BLOCKED gate passes only when accepted-exceptions.json (docs/release.md#accepted-exceptions) names this gate receipt
 *  by sha256 and this cut, says `accepted_by: maintainer`, and covers every blocker exactly. The receipts are read as the
 *  tools wrote them; the accepted entries are cleared in memory and the usual verdict runs on what is left.
 *  `companion` is the release receipt (release-receipt/1) or, without one, the ship receipt. */
export function acceptedProblems(gate, gateSha256, companion, x, sha) {
  const out = [], lines = [], key = t => `${t?.step}: ${t?.id}`;
  if (x?.schema !== 'accepted-exceptions/1') out.push('not an accepted-exceptions file (accepted-exceptions/1)');
  if (x?.accepted_by !== 'maintainer') out.push(`accepted_by is ${x?.accepted_by}, not maintainer`);
  if (!/^\d{4}-\d\d-\d\d$/.test(x?.date ?? '')) out.push(`date ${x?.date} is not YYYY-MM-DD`);
  if (x?.cut !== sha) out.push(`the exceptions are for cut ${x?.cut}, not this commit`);
  if (x?.gate_sha256 !== gateSha256) out.push('the exceptions name a different gate receipt (sha256)');
  if (gate?.status !== 'blocked') out.push(`gate status ${gate?.status}: nothing to accept`);
  if (gate?.newFailures?.length) out.push(`gate has ${gate.newFailures.length} new failures: never accepted`);
  const listed = { removed: new Set(), unexpectedSkips: new Set() };
  for (const e of Array.isArray(x?.exceptions) && x.exceptions.length ? x.exceptions : [{}]) {
    if (!Object.hasOwn(ACCEPTABLE, e?.kind)) { out.push(`exception kind ${e?.kind} is never accepted`); continue; }
    if (!e.reason?.trim?.() || !/^#\d+$/.test(e.ref ?? '') || !e.tests?.length) out.push(`each ${e.kind} exception needs a reason, a ref (#issue or #PR) and its tests`);
    for (const t of e.tests ?? []) listed[e.kind].add(key(t));
    lines.push(`ACCEPTED ${e.kind} (${e.ref}): ${e.reason}`, ...(e.tests ?? []).map(t => `   ${key(t)}`));
  }
  const ours = new Set();
  for (const [k, phrase] of Object.entries(ACCEPTABLE)) {
    const entries = gate?.[k] ?? [], inReceipt = new Set(entries.map(key));
    for (const t of inReceipt) if (!listed[k].has(t)) out.push(`not accepted: ${k} ${t}`);
    for (const t of listed[k]) if (!inReceipt.has(t)) out.push(`accepted but not in the receipt: ${k} ${t}`);
    if (entries.length) ours.add(`${entries.length} ${phrase}`);
  }
  for (const b of gate?.blockers ?? []) if (!ours.has(b)) out.push(`gate blocker is never accepted: ${b}`);
  if (out.length) return { problems: out, lines };
  // once the accepted entries are gone, so are the two lines a blocked gate puts in the ship verdict (ship-receipt.mjs)
  const status = gate.quarantined?.length ? 'quarantined' : 'pass', fromGate = ['gate status blocked', `gate has ${gate.blockers.length} blocker(s)`];
  if (companion?.schema === 'release-receipt/1') {
    const g = companion.gate ?? {};
    if (g.sha256 !== gateSha256) return { problems: ['the release receipt names a different gate receipt'], lines };
    if (companion.blockers !== fromGate.length || ['blockers', 'removed', 'unexpectedSkips'].some(k => g[k] !== (gate[k]?.length ?? 0)))
      return { problems: [`the release receipt blocks beyond the accepted gate blockers (${companion.blockers} blockers)`], lines };
    return { problems: releaseReceiptProblems({ ...companion, status, blockers: 0, gate: { ...g, status, blockers: 0, removed: 0, unexpectedSkips: 0 } }, sha), lines };
  }
  const extra = (companion?.blockers ?? []).filter(b => !fromGate.includes(b));
  if (extra.length) return { problems: extra.map(b => `ship receipt blocker is never accepted: ${b}`), lines };
  return { problems: receiptProblems({ ...gate, status, blockers: [], removed: [], unexpectedSkips: [] }, { ...companion, status, blockers: [] }, sha, gateSha256), lines };
}

/** The same verdict from the publishable release receipt alone, as the release workflow holds it (#2262): a blocked gate's
 *  release receipt carries its count blocker lines and the removed and skipped tests, and the raw gate receipt's sha256.
 *  Lists that disagree with their counts, or are missing, refuse. */
export function acceptedReleaseProblems(r, x, sha) {
  const g = r?.gate ?? {}, n = k => Array.from({ length: Number(g[k]) || 0 }, () => ({}));
  if (!Array.isArray(g.blockerLines) || g.blockerLines.length !== g.blockers || g.removedTests?.length !== g.removed || g.unexpectedSkipTests?.length !== g.unexpectedSkips)
    return { problems: ['the release receipt does not list the gate\'s blockers and tests (ship-receipt.mjs --public from #2262 on)'], lines: [] };
  const gate = { status: g.status, blockers: g.blockerLines, newFailures: n('newFailures'), quarantined: n('quarantined'), removed: g.removedTests, unexpectedSkips: g.unexpectedSkipTests };
  return acceptedProblems(gate, g.sha256, r, x, sha);
}

export function snapshotProblems(health, remote, sha = '', accepted = []) {
  const out = [], previous = remote.productionTarget.split('/').pop();
  if (sha && previous === `we-${sha.slice(0, 12)}`) out.push('this commit is already live: a new snapshot would name it as the previous build');
  if (!health.ok || (!health.hostOk && !accepted.length)) out.push('public healthz is not ok');
  else if (!health.hostOk) {
    // #1356: a release that fixes a halted world may pass only the codes it names; an unnamed or missing code still refuses
    const codes = Array.isArray(health.hostCodes) ? health.hostCodes : [], other = codes.filter(c => !accepted.includes(c));
    if (!codes.length || other.length) out.push(`public healthz is not ok: host codes ${codes.join(',') || 'none'}, accepted only ${accepted.join(',')}`);
  }
  if (health.build !== previous || remote.activeBuild !== previous) out.push(`stage link ${previous}, healthz ${health.build}, keeper ${remote.activeBuild} disagree`);
  if (health.worlds !== remote.worlds) out.push(`healthz has ${health.worlds} worlds, the registry ${remote.worlds}`);
  if (!(remote.databases >= remote.worlds)) out.push(`${remote.databases} databases for ${remote.worlds} worlds`);
  if (!(Number(remote.keeperPid) > 1) || Number(remote.keeperPid) !== remote.servicePid) out.push('keeper and service pid differ');
  if (remote.keeperSha !== remote.deployedKeeperSha) out.push('keeper source differs from the deployed release');
  if (!IDLE_HANDOVERS.includes(remote.handoverState)) out.push(`handover ${remote.handoverState} is active`);
  return out;
}

export function driftProblems(before, health, remote) {
  const out = [];
  for (const k of HEALTH_KEYS) if (JSON.stringify(health[k]) !== JSON.stringify(before.publicHealth[k])) out.push(`public health ${k} changed`);
  for (const k of DRIFT_KEYS) if (JSON.stringify(remote[k]) !== JSON.stringify(before.remote[k])) out.push(`${k} changed`);
  return out;
}

/** The receipt, or throws. compact-copy prints one JSON row per database; compact-backup's last line is the folder. */
export function backupReceipt(log, quick, snapshot, snapshotSha256, label, now = new Date()) {
  const lines = log.split('\n').filter(Boolean), folder = lines.at(-1) ?? '', want = snapshot.remote;
  const escaped = label.replace(/[^A-Za-z0-9_-]/g, '');
  if (!new RegExp(`^/.+/pre-r${escaped}-production-[A-Za-z0-9-]+$`).test(folder)) throw Error('the backup did not name its folder');
  const rows = lines.filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  if (rows.length !== want.databases) throw Error(`${rows.length} rows of copies for ${want.databases} databases`);
  if (!rows.every(r => r.dropped && !Object.keys(r.dropped).length)) throw Error('a compact copy dropped rows');
  const checks = quick.split('\n').filter(Boolean);
  if (!checks.every(l => l.startsWith('ok '))) throw Error('a backup failed quick_check');
  const found = checks.map(l => l.slice(3).replace(`${folder}/`, '')).sort();
  if (JSON.stringify(found) !== JSON.stringify([...want.databasePaths].sort())) throw Error('backup filenames differ from the snapshot');
  return { at: now.toISOString(), status: 'pass', databases: want.databases, quickChecks: checks.length, rowsCopiedAndCompared: true, backup: folder, dataRestored: false, snapshotSha256, databasePaths: want.databasePaths };
}

export function activationProblems(snapshot, snapshotSha256, backup, upload, manifestSha256, now = Date.now()) {
  const out = [], fresh = at => { const age = now - Date.parse(at); return age >= 0 && age < HOUR_MS; };
  if (!fresh(snapshot.at)) out.push('the snapshot is over an hour old: rerun from snapshot');
  if (!fresh(backup.at)) out.push('the backup is over an hour old: rerun from backup');
  if (backup.status !== 'pass' || backup.snapshotSha256 !== snapshotSha256) out.push('the backup receipt is not for this snapshot');
  if (backup.databases !== snapshot.remote.databases || backup.quickChecks !== backup.databases) out.push('the backup does not cover every database');
  if (upload.sha !== snapshot.candidate || upload.manifestSha256 !== manifestSha256) out.push('the upload receipt does not match the local manifest');
  return out;
}

const fail = lines => { for (const l of lines) console.log(l); process.exit(1); };
export function main(argv) {
  const [cmd, ...a] = argv;
  if (cmd === 'receipt') { const p = releaseReceiptProblems(read(a[0]), a[1]); if (p.length) fail(p); console.log('the release receipt is clean for this commit'); }
  else if (cmd === 'accepted') {
    const gate = join(a[0], 'receipt.json'), release = join(a[0], 'release-receipt.json');
    // the raw gate receipt when the folder has it (the laptop); the release receipt alone otherwise (release.yml, #2262)
    const { problems, lines } = !existsSync(gate) ? acceptedReleaseProblems(read(release), read(a[1]), a[2]) : acceptedProblems(read(gate), digest(gate), read(existsSync(release) ? release : join(a[0], 'ship-receipt.json')), read(a[1]), a[2]);
    if (problems.length) fail(problems);
    for (const l of lines) console.log(l);
    console.log('the receipts are clean for this commit apart from the exceptions the maintainer accepted');
  } else if (cmd === 'receipts') { const p = receiptProblems(read(a[0]), read(a[1]), a[2], digest(a[0])); if (p.length) fail(p); console.log('gate and ship receipts are clean for this commit'); }
  else if (cmd === 'snapshot') {
    const accepted = (a[4] ?? '').split(',').filter(Boolean), health = read(a[0]), remote = read(a[1]), p = snapshotProblems(health, remote, a[2], accepted); if (p.length) fail(p);
    if (existsSync(a[3])) { const aside = `${a[3]}.${Date.now()}`; renameSync(a[3], aside); console.log(`kept the earlier snapshot as ${aside.split('/').pop()}`); }
    const publicHealth = Object.fromEntries(HEALTH_KEYS.map(k => [k, health[k]]));
    writeFileSync(a[3], JSON.stringify({ schema: 'ship-snapshot/1', at: new Date().toISOString(), candidate: a[2], previousBuild: remote.productionTarget.split('/').pop(), publicHealth, ...(accepted.length ? { acceptedHostCodes: accepted } : {}), remote, databaseContentsRead: false }, null, 2) + '\n', { flag: 'wx' });
    if (!health.hostOk) console.log(`hostOk is false; accepted host codes ${health.hostCodes.join(',')} (--accept-host-codes ${accepted.join(',')})`);
    console.log(`${remote.worlds} worlds, ${remote.databases} databases, previous ${remote.productionTarget.split('/').pop()}`);
  } else if (cmd === 'drift') { const p = driftProblems(read(a[0]), read(a[1]), read(a[2])); if (p.length) fail(p); console.log('live metadata equals the snapshot'); }
  else if (cmd === 'backup') {
    const r = backupReceipt(readFileSync(a[0], 'utf8'), readFileSync(a[1], 'utf8'), read(a[2]), digest(a[2]), a[3]);
    writeFileSync(a[4], JSON.stringify(r, null, 2) + '\n', { flag: 'wx' }); console.log(`${r.databases} databases copied, compared and quick-checked`);
  } else if (cmd === 'activation') { const p = activationProblems(read(a[0]), digest(a[0]), read(a[1]), read(a[2]), digest(a[3])); if (p.length) fail(p); console.log('snapshot, backup and upload are fresh and agree'); }
  else if (cmd === 'health') { const h = read(a[0]); if (!h.ok || !h.hostOk || h.build !== a[1] || h.worlds !== Number(a[2])) fail([`healthz: ok ${h.ok}, hostOk ${h.hostOk}, build ${h.build}, worlds ${h.worlds}`]); console.log(`healthz ok, ${h.build}, ${h.worlds} worlds`); }
  else if (cmd === 'rehearse') {
    const r = rehearseReceipt(readFileSync(a[0], 'utf8'), a[1]); writeFileSync(a[2], JSON.stringify(r, null, 2) + '\n');
    if (r.problems.length) fail(r.problems);
    console.log(`${r.passed} of ${r.worlds} worlds boot and run on ${a[1]}${r.approximate.length ? `; approximate, not a verdict: ${r.approximate.join(', ')}` : ''}${r.slow.length ? `; SLOW boot: ${r.slow.join(', ')}` : ''}`);
  } else if (cmd === 'rehearsed') { const r = existsSync(a[0]) ? read(a[0]) : null; if (r?.status !== 'pass' || r.build !== a[1]) fail([`no passing boot rehearsal of ${a[1]}`]); console.log(`boot rehearsal passed for ${r.worlds} worlds`); }
  else fail([`unknown command ${cmd}`]);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(process.argv.slice(2)); } catch (e) { fail([e.message]); }
}
