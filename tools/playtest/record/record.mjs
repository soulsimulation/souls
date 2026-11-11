// #1774: the full session record of a playtest run. Each seat runs with the client's own record on (#1773, client 2.29.0:
// `.eden-record-on`), and at close the run gathers, per seat, the collected session bundle (tools/soul-trace/collect.mjs:
// client record, serve log, the seat's raw Claude Code transcript with its reasoning, receipt and message end states,
// versions), beside the persona's transcript, the observer's evidence, the world's log and the world's own per-request
// record (apps/server/src/load/request-record.ts). record.json in the run folder names every one of them.
//
// The numbers are #1752's (tools/playtest/eval/measure.mjs, report.mjs), read from the session record: one recorder, not
// two. This module only cuts the run into instruction windows and feeds them in. A bundle is PRIVATE: never attach it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readJson, readJsonl, writeJson } from '../lib/jsonl.mjs';
import { httpSince, routeStats, refusalCounts, seatStats, isLongPoll, judge, catalogIndex, summarize, validateBattery } from '../eval/measure.mjs';
import { renderReport } from '../eval/report.mjs';

export const RUN_RECORD_SCHEMA = 'playtest-run-record/1';
export { RECORD_ON, recordOn } from './switch.mjs';

/** The record's rows, oldest first, from a collected bundle (client/record*.jsonl) or a Soul's own .eden-record folder. */
export function recordRows(dir) {
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /^record(?:-\d+-[0-9a-f]+)?\.jsonl$/.test(f));
  return files.flatMap((f) => readJsonl(join(dir, f))).filter((r) => r?.v === 'soul-trace/2').sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/** A recorded path as soul-trace/1 keeps a route: no world prefix (`/w/<slug>`), and the query's keys without their values. */
export function routeOf(path) {
  const [p, q] = String(path ?? '').split('?');
  const keys = q ? [...new URLSearchParams(q).keys()] : [];
  return p.replace(/^\/w\/[a-z0-9-]+(?=\/)/, '') + (keys.length ? `?${keys.join('&')}` : '');
}

/** A command's world calls in the record (kind http; serve's own `wire` calls are not the agent's) in the shape #1752's
 *  measures read (soul-trace/1 http: route, durationMs, serverMs, facts.accepted/code). */
export function traceFromRecord(rows) {
  const out = [];
  for (const r of rows) {
    if (r?.kind !== 'http' || r.proxied) continue;
    const res = r.res && typeof r.res === 'object' && !r.res.cut ? r.res : null;
    const code = res?.error?.code ?? (typeof res?.code === 'string' ? res.code : undefined);
    out.push({ v: 'soul-trace/1', kind: 'http', at: r.wallStart ?? r.at, method: r.method ?? 'GET', route: routeOf(r.path), status: r.status ?? 0, durationMs: r.ms ?? null,
      serverMs: r.server?.world ?? null, queueMs: r.server?.queue ?? null, key: r.key ?? null, ids: r.ids ?? null,
      facts: { ...(typeof res?.accepted === 'boolean' ? { accepted: res.accepted } : {}), ...(code ? { code } : {}) } });
  }
  return out;
}

const LOOKUPS = new Set(['find', 'query']);
/** Did a lookup's printed answer find nothing? find: `found` empty; query: every answer empty. */
export function lookupEmpty(command, stdout) {
  let d = stdout; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return null; } }
  if (!d || typeof d !== 'object' || d.cut) return null;
  if (command === 'find') return Array.isArray(d.found) ? d.found.length === 0 : null;
  if (command === 'query') {
    if (!Array.isArray(d.answers)) return null;
    const empty = (a) => !a || a.error || Object.values(a).every((v) => !Array.isArray(v) || v.length === 0);
    return d.answers.every(empty);
  }
  return null;
}
/** The agent's local lookups in [since, until): each find/query command, whether it found nothing, and the stretches of
 *  lookups in a row (no other command between) that held an empty answer, with how long each stretch took from its first
 *  lookup's start to its last one's end (#1773 A9: six empty lookups, about 25 s, for "Sit down"). */
export function lookupStats(rows, since = 0, until = Infinity) {
  const starts = new Map(), cmds = [];
  for (const r of rows) {
    if (r.kind === 'proc.start' && r.command) starts.set(r.proc, r);
    if (r.kind === 'proc.end' && starts.has(r.proc)) {
      const s = starts.get(r.proc), at = s.at ?? r.wallStart;
      if (at >= since && at < until && s.command !== 'serve' && s.command !== 'listen') cmds.push({ command: s.command, at, end: at + (r.ms ?? 0), empty: LOOKUPS.has(s.command) ? lookupEmpty(s.command, r.stdout) : null });
    }
  }
  cmds.sort((a, b) => a.at - b.at);
  const stretches = []; let cur = null;
  for (const c of cmds) {
    if (LOOKUPS.has(c.command)) { cur ??= { lookups: 0, empty: 0, from: c.at, to: c.end }; cur.lookups++; if (c.empty) cur.empty++; cur.to = c.end; }
    else { if (cur?.empty) stretches.push(cur); cur = null; }
  }
  if (cur?.empty) stretches.push(cur);
  const lookups = cmds.filter((c) => LOOKUPS.has(c.command));
  return { lookups: lookups.length, empty: lookups.filter((c) => c.empty).length, emptyStretches: stretches.map((s) => ({ lookups: s.lookups, empty: s.empty, ms: Math.round(s.to - s.from) })),
    longestEmptyStretchMs: stretches.length ? Math.max(...stretches.map((s) => Math.round(s.to - s.from))) : 0 };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** The battery item an owner message is (its words, ignoring case and punctuation), or null. */
export const itemFor = (battery, text) => (battery?.items ?? []).find((it) => norm(it.instruction) === norm(text)) ?? null;

/** #1752's `observe` from an observer snapshot (observer/world-truth.mjs projectSoul). */
export const obsOf = (snap) => ({ placeIds: snap?.placeIds ?? (snap?.place ? [snap.place] : []), place: snap?.place ?? null, posture: snap?.bodyPosture ?? null, activity: snap?.activity ?? null, receipts: snap?.receipts ?? [] });

/** The instruction windows of one seat: each owner request (an evidence pack) from its sending to the next one's, or to
 *  its own cutoff for the last. */
export function windowsOf(evidence) {
  const packs = evidence.filter((e) => e?.sentAt).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  return packs.map((e, i) => ({ evidence: e, since: Date.parse(e.sentAt), until: i + 1 < packs.length ? Date.parse(packs[i + 1].sentAt) : Math.max(Date.parse(e.cutoffAt ?? e.sentAt), Date.parse(e.sentAt)) + 1 }));
}

/** One instruction window measured as a #1752 episode record. */
export function measureWindow({ win, trace, server = [], rows = [], turns = [], transcript = [], battery = null, catalog = null }) {
  const e = win.evidence, item = itemFor(battery, e.text);
  const http = httpSince(trace, win.since, win.until), routes = routeStats(http), nonPoll = routes.filter((r) => !r.longPoll), calls = nonPoll.reduce((s, r) => s + r.n, 0);
  const mean = (k) => { const xs = http.filter((r) => !isLongPoll(r.route)).map((r) => r[k]).filter(Number.isFinite); return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null; };
  const samples = e.samples ?? [], first = samples[0] ?? null, last = samples.at(-1) ?? null;
  const prior = new Set((first?.receipts ?? []).map((r) => `${r.id}|${r.phase}`));
  const newReceipts = (e.receipts ?? []).filter((r) => !prior.has(`${r.id}|${r.phase}`));
  const card = e.channel === 'card' ? { state: e.resultState ?? null, outcome: e.resultState ?? null, resultAt: e.resultAt ?? null } : null;
  let verdict = { ok: null, why: 'no battery item for this message' };
  if (item) verdict = last ? judge(item.check, { obs: obsOf(last), newReceipts, card, catalog, noCard: e.channel !== 'card' }) : { ok: false, why: 'no observer sample in the window' };
  // the world's own lines for this agent's calls: joined by the client's idempotency key or a receipt it named; long polls
  // (held open by design) and everyone else's reads (the observer, the owner card) left out
  const keys = new Set(http.map((r) => r.key).filter(Boolean)), rids = new Set(http.flatMap((r) => r.ids?.receipts ?? []));
  const sv = server.filter((s) => s.at >= win.since && s.at < win.until && !isLongPoll(routeOf(s.path)) && ((s.key && keys.has(s.key)) || (s.receipts ?? []).some((id) => rids.has(id))));
  const q = (xs, p) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null; };
  return {
    item: item?.id ?? e.requestId, requestId: e.requestId, instruction: e.text, channel: e.channel, repeat: 1, succeeded: verdict.ok === true, judged: verdict.ok !== null && !verdict.unknown, why: verdict.why,
    endedBy: e.cutoffReason ?? null, sentAt: e.sentAt, wallMs: win.until - win.since,
    firstMotionMs: e.firstBodyChangeAt ? Date.parse(e.firstBodyChangeAt) - win.since : null, successMs: null,
    card: card ? { state: card.state, outcome: card.outcome, acked: !!e.ackAt, closed: !!e.resultAt } : null,
    seat: seatStats(turns, transcript, win.since, win.until),
    worldCalls: calls, longPolls: http.length - calls, routes, refusals: refusalCounts(http), clientMsPerCall: mean('durationMs'), serverMsPerCall: mean('serverMs'),
    lookups: lookupStats(rows, win.since, win.until),
    serverRecord: sv.length ? { requests: sv.length, worldMsP50: q(sv.map((s) => s.worldMs), 0.5), worldMsMax: q(sv.map((s) => s.worldMs), 1), queueMsMax: q(sv.map((s) => s.queueMs), 1) } : null,
  };
}

/** Collect one seat's session bundle into <out> (tools/soul-trace/collect.mjs, in process). Never throws: a failure is
 *  returned and named in record.json. */
export async function collectSeat({ folder, out, claudeDirs = [], since, until }) {
  try {
    const { collect } = await import('../../soul-trace/collect.mjs');
    return { ok: true, ...(await collect({ folder, out, claudeDirs, transcripts: [], fetch: true, ...(since ? { since } : {}), ...(until ? { until } : {}) })) };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 400) }; }
}

/** The seat's Claude Code config folder: the seat's own (CLAUDE_CONFIG_DIR, as #1688's clean launch sets), else ~/.claude. */
export const seatClaudeDirs = (env = process.env) => [env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')];

const listDir = (d) => (existsSync(d) ? readdirSync(d) : []);
/** finishRunRecord({runDir, seats, scenario, world, log}) → record.json + MEASURES.md in the run folder, and the report text.
 *  seats: [{id, folder, dir (the seat's harness folder: turns.jsonl, transcript.jsonl), soulId}]. Run at close, while the
 *  world still answers (collect fetches receipt and message end states). */
export async function finishRunRecord({ runDir, seats, scenario = {}, world = {}, claudeDirs = seatClaudeDirs(), collect = collectSeat, log = () => {} }) {
  const battery = scenario.battery?.file ? readJson(resolve(scenario.battery.file)) : scenario.battery?.items ? scenario.battery : null;
  if (battery) { const errs = validateBattery(battery); if (errs.length) throw new Error(`battery: ${errs.join('; ')}`); }
  const serverFile = join(runDir, 'server', 'requests.jsonl'), server = readJsonl(serverFile);
  const evidenceAll = listDir(join(runDir, 'evidence')).filter((f) => f.endsWith('.json')).map((f) => readJson(join(runDir, 'evidence', f))).filter(Boolean);
  const index = { schema: RUN_RECORD_SCHEMA, private: true, privateNote: 'Each seat bundle holds the owner\'s chat, the agent\'s reasoning and local paths. Never attach it, or quotes from it, to an issue, a pull request or a proof.',
    world: { log: existsSync(join(runDir, 'server', 'world.log')) ? 'server/world.log' : null, requests: existsSync(serverFile) ? 'server/requests.jsonl' : null,
      requestsNote: existsSync(serverFile) ? 'the world\'s own per-request record (world-request/1): arrival, world and queue ms, idempotency key, receipt and message ids' : world.remote ? 'a given world URL: no per-request record (production\'s is #1750)' : 'none written' },
    seats: [], episodes: [] };
  const episodes = [];
  for (const s of seats) {
    const out = join(runDir, 'seats', s.id, 'record');
    const evidence = evidenceAll.filter((e) => e.seat === s.id);
    const span = evidence.map((e) => Date.parse(e.sentAt)).filter(Number.isFinite);
    const c = existsSync(join(out, 'manifest.json')) ? { ok: true, reused: true } : await collect({ folder: s.folder, out, claudeDirs });
    log(`seat ${s.id}: record ${c.ok ? `collected (${c.records ?? '?'} records, ${c.transcripts ?? '?'} transcripts)` : `NOT collected: ${c.error}`}`);
    const rows = recordRows(join(out, 'client')), trace = traceFromRecord(rows);
    const catalog = catalogIndex(readJson(join(s.runtime ?? s.folder, 'world-catalog.json'))?.catalog ?? null);
    const turns = readJsonl(join(s.dir, 'turns.jsonl')), transcript = readJsonl(join(s.dir, 'transcript.jsonl'));
    const v = readJson(join(out, 'versions.json')), client = { cli: v?.client?.file?.version ?? v?.client?.recorded?.[0] ?? null, skill: v?.skill?.[0]?.version ?? null };
    for (const win of windowsOf(evidence)) episodes.push({ seatId: s.id, ...measureWindow({ win, trace, server, rows, turns, transcript, battery, catalog }), client });
    const personaDir = join(runDir, 'personas', s.id);
    index.seats.push({ id: s.id, soulId: s.soulId ?? null, bundle: c.ok ? relative(runDir, out) : null, bundleError: c.ok ? null : c.error, records: rows.length, worldCalls: trace.length,
      harness: { turns: relative(runDir, join(s.dir, 'turns.jsonl')), transcript: relative(runDir, join(s.dir, 'transcript.jsonl')), listen: existsSync(join(s.dir, 'listen.jsonl')) ? relative(runDir, join(s.dir, 'listen.jsonl')) : null },
      persona: existsSync(personaDir) ? { transcript: existsSync(join(personaDir, 'turns.jsonl')) ? relative(runDir, join(personaDir, 'turns.jsonl')) : null, decisions: existsSync(join(personaDir, 'decisions.jsonl')) ? relative(runDir, join(personaDir, 'decisions.jsonl')) : null, requests: existsSync(join(personaDir, 'requests.jsonl')) ? relative(runDir, join(personaDir, 'requests.jsonl')) : null } : null,
      evidence: evidence.map((e) => `evidence/${e.requestId}.json`), window: span.length ? { first: new Date(Math.min(...span)).toISOString(), last: new Date(Math.max(...span)).toISOString() } : null });
  }
  index.episodes = episodes.map(({ routes, ...e }) => e);
  // #1752's report counts what it judged: messages that are battery items. Follow-ups and chatter stay in the run facts.
  const shown = episodes.some((e) => e.judged) ? episodes.filter((e) => e.judged) : episodes;
  const result = { battery: battery?.battery ?? scenario.name ?? 'run', world: world.remote ? 'given-url' : `local:${scenario.world?.slug ?? 'dev'}`, seat: { adapter: scenario.seats?.[0]?.adapter ?? 'claude-headless', model: scenario.seats?.[0]?.model ?? null },
    serverCommit: world.build ?? null, repeats: 1, warmSec: 0, spentUsd: episodes.reduce((s, e) => s + (e.seat.costUsd ?? 0), 0), episodes: shown, summary: summarize(shown) };
  const md = renderReport(result) + runFacts(episodes);
  writeJson(join(runDir, 'record.json'), index);
  writeFileSync(join(runDir, 'MEASURES.md'), md);
  return { index, result, md };
}

/** What the run adds beside #1752's numbers: the local lookups that found nothing, and the world's own per-request record. */
export function runFacts(episodes) {
  const L = ['', '## Run facts (#1774)', '', 'Local lookups are the agent\'s `find` and `query` commands; a stretch is lookups in a row with at least one empty answer. The server lines are the dev world\'s own record (world-request/1) of this agent\'s calls, joined by idempotency key or receipt id; long polls left out.', '',
    '| request | item | judged | lookups (empty) | longest empty stretch | server lines joined | server world ms p50 / max | queue ms max |', '|---|---|---|---|---|---|---|---|'];
  for (const e of episodes) L.push(`| ${e.requestId} | ${e.item} | ${e.judged ? (e.succeeded ? 'yes' : 'no') : 'not judged'} | ${e.lookups.lookups} (${e.lookups.empty}) | ${e.lookups.longestEmptyStretchMs ? `${(e.lookups.longestEmptyStretchMs / 1000).toFixed(1)} s` : '-'} | ${e.serverRecord?.requests ?? '-'} | ${e.serverRecord ? `${e.serverRecord.worldMsP50} / ${e.serverRecord.worldMsMax}` : '-'} | ${e.serverRecord?.queueMsMax ?? '-'} |`);
  return L.join('\n') + '\n';
}
