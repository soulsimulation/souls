// Soul Client eval (#1752): one episode = one battery instruction to one Soul, end to end.
// The harness sets the folder up as an owner would (the world's served eden.mjs and skill.md, register, create, the client's
// own trace switched on, `serve`), gives the agent one kickoff turn, then sends the instruction as an owner message through
// the owner inbox, the way the Soul's web card does. An observer reads the public Soul view (never the seat) until the item's
// check holds, the card closes, or the item's timeout. The seat keeps Claude Code's background `listen` (the arena wake loop).
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { run } from '../lib/proc.mjs';
import { readJsonl, writeJson } from '../lib/jsonl.mjs';
import { sleep } from '../lib/clock.mjs';
import { createSeat, Seat } from '../arena/seat.mjs';
import { worldBudgetFor } from '../arena/world-budget.mjs';
import { sendCard, cardView, publicSoul, cardSummary } from '../arena/owner.mjs';
import { observe, judge, cardClosed, httpSince, routeStats, refusalCounts, seatStats, catalogIndex, isLongPoll, validateBattery } from './measure.mjs';

export const kickoffText = (name, skillFile = 'skill.md') => `Your Soul ${name} lives in this folder; it is already set up and \`serve\` is running. Your guide is ${skillFile} in this folder: read it, then start listening for my messages as it says.`;

export const cli = async (folder, args, maxWallMs = 60000) => {
  const r = await run('node', ['eden.mjs', ...args], { cwd: folder, maxWallMs });
  let data = null; try { data = JSON.parse(r.stdout); } catch { /* plain */ }
  return { code: r.code, data, stdout: r.stdout, stderr: r.stderr };
};
async function fetchServed(base, path, to) {
  const r = await fetch(`${base}/${path}`, { signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  if (!r.ok || /^\s*<!doctype html/i.test(body)) throw new Error(`${path}: HTTP ${r.status}`);
  writeFileSync(to, body);
  return body;
}

/** The Soul's runtime folder in a Souls home (2.25: .souls/souls/<id>/runtime), else the folder itself (a legacy folder). */
export function runtimeDir(folder, soulId) {
  const d = join(folder, '.souls', 'souls', soulId, 'runtime');
  return existsSync(d) ? d : folder;
}

/** Owner's setup of a fresh seat folder (local dev worlds only: register and create need no account there). */
export async function prepareFolder(seat, { name }) {
  const f = seat.folder, base = seat.base;
  const cliText = await fetchServed(base, 'eden.mjs', join(f, 'eden.mjs'));
  const skill = await fetchServed(base, 'skill.md', join(f, 'skill.md'));
  const steps = [['register', base], ['create', name]];
  let createdAt = null;
  for (const s of steps) { if (s[0] === 'create') createdAt = Date.now(); const r = await cli(f, s); if (r.code !== 0) throw new Error(`setup ${s[0]} exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`); }
  const st = await cli(f, ['status']);
  const soulId = st.data?.soul?.id;
  if (!soulId) throw new Error(`setup: no Soul after create: ${st.stdout.slice(0, 300)}`);
  seat.info.soulId = soulId; seat.info.soulName = name; seat.save();
  writeFileSync(join(runtimeDir(f, soulId), '.eden-report-on'), '');
  await cli(f, ['serve', '--stop']).catch(() => {});
  const sv = await cli(f, ['serve']);
  if (!sv.data?.serving) throw new Error(`setup: serve did not start: ${sv.stdout.slice(0, 300)}`);
  for (let i = 0; i < 60 && !existsSync(join(runtimeDir(f, soulId), 'world-catalog.json')); i++) { const l = await cli(f, ['look']); if (!l.data) break; await sleep(500); }   // the world copy (a client before 2.25 has no look)
  return { soulId, createdAt, cliVersion: /const VERSION = "([^"]+)"/.exec(cliText)?.[1] ?? null, skillVersion: /^\s*version:\s*"?([^"\s]+)/m.exec(skill)?.[1] ?? null };
}

/** Read the client's world copy (soul-catalog/1) from the Soul's runtime folder, or null. */
export function readCatalog(folder, soulId) {
  try { return JSON.parse(readFileSync(join(runtimeDir(folder, soulId), 'world-catalog.json'), 'utf8')).catalog ?? null; } catch { return null; }
}

/** A fresh seat (new agent session, own records) on a folder an owner already paired, e.g. a production test Soul.
 *  The harness never registers, creates or pairs here: it reads `status`, turns the client's trace on and starts `serve`. */
export async function attachFolder({ dir, folder, base, seatCfg, rails, refreshClient = false }) {
  const seatDir = join(dir, 'seats', 'soul'); mkdirSync(seatDir, { recursive: true });
  const seat = new Seat({ dir: seatDir, seat: { ...seatCfg, id: 'soul' }, worldBase: base, rails, budget: worldBudgetFor(dir, { capUsd: rails?.worldBudgetUsd, turnCapUsd: rails?.turnBudgetUsd }) });
  const generated = seat.folder; seat.folder = folder;
  seat.allowedTools = seat.allowedTools.map((t) => t.split(generated).join(folder));
  seat.info.folder = null; seat.save();
  const st = await cli(folder, ['status']);
  const soulId = st.data?.soul?.id;
  if (!st.data?.paired || !soulId) throw new Error(`--folder is not a paired Soul folder (status: ${st.stdout.slice(0, 200)})`);
  seat.info.soulId = soulId; seat.info.soulName = st.data.soul.name ?? null; seat.save();
  // The owner's own files stay as they are, unless the run asks to refresh them from the world (as an owner updates a client)
  const skillFile = readdirSync(folder).find((f) => /^skill\.md$/i.test(f)) ?? 'skill.md';
  if (refreshClient) { await fetchServed(base, 'eden.mjs', join(folder, 'eden.mjs')); await fetchServed(base, 'skill.md', join(folder, skillFile)); }
  if (!existsSync(join(folder, skillFile))) throw new Error(`no ${skillFile} in --folder (use --refresh-client to fetch the served one)`);
  const skill = readFileSync(join(folder, skillFile), 'utf8');
  writeFileSync(join(runtimeDir(folder, soulId), '.eden-report-on'), '');
  await cli(folder, ['serve', '--stop']).catch(() => {});
  const sv = await cli(folder, ['serve']);
  if (!sv.data?.serving) throw new Error(`serve did not start: ${sv.stdout.slice(0, 300)}`);
  await cli(folder, ['look']);
  const cliText = readFileSync(join(folder, 'eden.mjs'), 'utf8');
  return { seat, setup: { soulId, skillFile, name: seat.info.soulName, cliVersion: /const VERSION = "([^"]+)"/.exec(cliText)?.[1] ?? null, skillVersion: /^\s*version:\s*"?([^"\s]+)/m.exec(skill)?.[1] ?? null } };
}

/** runEpisode({dir, base, item, seatCfg, rails, folder?, deliver?, resetTo?}) → the episode record (also written to dir/episode.json).
 *  deliver "inbox" (default): the instruction is an owner message (local dev worlds: the dev owner identity). "chat": it is
 *  typed into the agent's chat, as a person at their own agent does; there is no card, so card checks read as unknown. */
export async function runEpisode({ dir, base, item, seatCfg, rails = {}, folder = null, catalogRef = null, refreshClient = false, deliver = 'inbox', resetTo = null, warmSec = 0, sampleMs = 500, holdSec = 15, graceSec = 10, log = () => {} }) {
  let seat, setup;
  if (folder) ({ seat, setup } = await attachFolder({ dir, folder, base, seatCfg, rails, refreshClient }));
  else { seat = createSeat({ runDir: dir, seat: { ...seatCfg, id: 'soul' }, worldBase: base, rails }); setup = await prepareFolder(seat, { name: seatCfg.soulName ?? 'Wren' }); }
  const name = seat.info.soulName ?? 'Wren';
  // #1989: the seat and its `serve` stop however the episode ends, a throw included (once; the trace is read after).
  let stopped = false;
  const stopSeat = async () => {
    if (stopped) return; stopped = true;
    let cap; await Promise.race([seat.stop(), new Promise((ok) => { cap = setTimeout(ok, (rails.maxTurnWallSec ?? 240) * 1000 + 5000); })]); clearTimeout(cap);
    await cli(seat.folder, ['serve', '--stop']).catch(() => {});
  };
  try {
    if (resetTo) { const r = await cli(seat.folder, ['act', `walk:${resetTo}`, '--wait', '60'], 120000); log(`${item.id}: reset to ${resetTo}: ${r.data?.receipt?.phase ?? r.data?.code ?? r.code}`); await cli(seat.folder, ['stop']).catch(() => {}); }
    // A client before 2.25 keeps no world copy; it is then checked and judged against a saved copy of the same template's
    // catalog (--catalog), never against nothing.
    const own = readCatalog(seat.folder, setup.soulId), catalogFrom = own ? 'client' : catalogRef ? 'reference' : null;
    if (!catalogFrom) throw new Error('the client keeps no world copy (world-catalog.json); pass --catalog <a saved copy of this template\'s catalog>');
    const catalog = catalogIndex(own ?? catalogRef);
    const bad = validateBattery({ items: [item] }, catalog);   // the battery is checked against this world's own catalog first
    if (bad.length) throw new Error(bad.join('; '));
    const rt = runtimeDir(seat.folder, setup.soulId), traceFile = join(rt, '.eden-report.jsonl');
    const ownerId = seat.info.ownerIdentity, soulId = setup.soulId;

    const pub0 = await publicSoul({ base, soulId });
    const before = observe(pub0), seen = new Set(before.receipts.map((r) => `${r.id}|${r.phase}`));
    if (item.start && !before.placeIds.includes(item.start)) throw new Error(`${item.id}: the Soul starts at ${before.place}, not ${item.start}`);

    const kick = await seat.chat(kickoffText(name, setup.skillFile), { reason: 'kickoff' });
    seat.wakeLoop();
    // --warm-sec: the instruction waits until the Soul is this old, so a run can show the steady state beside the cold start
    if (warmSec > 0 && setup.createdAt) { const wait = setup.createdAt + warmSec * 1000 - Date.now(); if (wait > 0) await sleep(wait); }
    const sentLocal = Date.now();
    const chatMode = deliver === 'chat';
    const sent = chatMode ? { messageId: null } : await sendCard({ base, soulId, identity: ownerId, text: item.instruction });
    if (chatMode) seat.chat(item.instruction, { reason: 'chat' }).catch(() => {});
    log(`${item.id}: sent ${chatMode ? 'as chat' : sent.messageId}`);

    const samples = [], deadline = sentLocal + (item.timeoutSec ?? 240) * 1000;
    let firstMotionMs = null, successAt = null, closedAt = null, verdict = { ok: false, why: 'timeout' }, card = null, endedBy = 'timeout';
    const priorIds = new Set(before.receipts.map((r) => r.id));
    while (Date.now() < deadline) {
      await sleep(sampleMs);
      let pub, view;
      try { [pub, view] = await Promise.all([publicSoul({ base, soulId }), chatMode ? null : cardView({ base, soulId, identity: ownerId })]); } catch (e) { samples.push({ t: Date.now() - sentLocal, error: String(e.message ?? e).slice(0, 120) }); continue; }
      const obs = observe(pub), t = Date.now() - sentLocal;
      card = cardSummary(view);
      if (card.messageId && card.messageId !== sent.messageId) card = { ...card, other: true };
      const newReceipts = obs.receipts.filter((r) => !priorIds.has(r.id) || !seen.has(`${r.id}|${r.phase}`));
      const moved = obs.place !== before.place || obs.posture !== before.posture || newReceipts.some((r) => r.firstMotionTick != null);
      if (firstMotionMs == null && moved) firstMotionMs = t;
      verdict = judge(item.check, { obs, newReceipts, card: card.other ? null : card, catalog, noCard: chatMode });
      samples.push({ t, place: obs.place, posture: obs.posture, activity: obs.activity, card: card.state, ok: verdict.ok });
      const closed = !chatMode && !card.other && cardClosed(card);
      if (closed && closedAt == null) closedAt = t;
      if (verdict.ok && successAt == null) successAt = t;
      if (!verdict.ok) successAt = null;   // a check must still hold at the end
      if (verdict.ok && closed) { endedBy = 'success+closed'; break; }
      if (verdict.ok && t - successAt >= holdSec * 1000) { endedBy = 'success-held'; break; }
      if (closed && !verdict.ok && t - closedAt >= graceSec * 1000) { endedBy = 'closed-unmet'; break; }
    }
    const endLocal = Date.now();
    await stopSeat();

    const trace = readJsonl(traceFile);
    mkdirSync(join(dir, 'trace'), { recursive: true });
    if (existsSync(traceFile)) copyFileSync(traceFile, join(dir, 'trace', 'eden-report.jsonl'));
    const http = httpSince(trace, sentLocal);
    const routes = routeStats(http);
    const nonPoll = routes.filter((r) => !r.longPoll);
    const callsN = nonPoll.reduce((s, r) => s + r.n, 0);
    const mean = (k) => { const xs = http.filter((r) => !isLongPoll(r.route)).map((r) => r[k]).filter(Number.isFinite); return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null; };
    const rec = {
      item: item.id, instruction: item.instruction, catalogFrom, sinceCreateMs: setup.createdAt ? sentLocal - setup.createdAt : null, succeeded: verdict.ok, why: verdict.why, endedBy, sentAt: new Date(sentLocal).toISOString(), wallMs: endLocal - sentLocal,
      firstMotionMs, successMs: verdict.ok ? successAt : null, cardClosedMs: closedAt, card: card ? { state: card.state, outcome: card.outcome, acked: !!card.ackAt, closed: cardClosed(card) } : null,
      seat: seatStats(readJsonl(join(seat.dir, 'turns.jsonl')), readJsonl(join(seat.dir, 'transcript.jsonl')), sentLocal),
      kickoff: { costUsd: kick?.usage?.costUsd ?? null, wallMs: kick?.wallMs ?? null, refused: kick?.refused ?? null, seatCheck: seat.info.seatCheck ?? null },
      worldCalls: callsN, longPolls: http.length - callsN, routes, refusals: refusalCounts(http), clientMsPerCall: mean('durationMs'), serverMsPerCall: mean('serverMs'),
      client: { cli: setup.cliVersion, skill: setup.skillVersion }, samples: samples.length,
    };
    writeJson(join(dir, 'episode.json'), rec);
    writeJson(join(dir, 'samples.json'), samples);
    return rec;
  } finally { await stopSeat(); }
}

// ---- cases (#1950): several scripted Souls on one world, each with its own script and checks, started and judged together
//
// A case is {id, bar, souls: [{id, name, folders?: ["second"], script: [step…]}]}. Every Soul is set up as an episode's is
// (prepareFolder), then all scripts run at once. A step is one of:
//   {run: [eden.mjs args], in?: "second", expect, keep?: true, withinSec?, from?: "restart"}
//        expect "ok" (exit 0), "accepted" (exit 0, not refused, no failed receipt), {refused: "<code>"} or {says: "<regex>"};
//        keep: the step's receipt id becomes {receipt}; {soul} is this Soul's id. withinSec: the step must also end within
//        that many seconds of the restart's start (from "restart") or of the step's own start.
//   {until: [eden.mjs args], phase: "ended", withinSec, from?}   rerun every 2 s until the receipt it prints has ended
//   {world: "restart", afterSec}                                    stop the world and start it again on the same data
//   {await: "restart"}                                              wait until the restart is done
// A folder in `folders` holds the same owner identity and is registered, never paired: its script steps say what it does.
// Every step is judged and the script goes on; the Soul passes when every step met its check, the case when every Soul did.
// A case with `drive` (#1974) has no scripts: a driver in hostile.mjs plays its Souls (`params` tune it) and reports the case's
// measures; `relay: true` puts its Souls behind a relay the driver can cut.
export const DRIVE_NAMES = ['act-spam', 'reconnect-storm', 'god-wall'];
export const ENDED_PHASES = ['completed', 'failed', 'refused', 'cancelled', 'interrupted', 'replaced', 'expired'];
const CODE = /\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+):/;

/** The refusal code one CLI output carries: an answer's `accepted: false` code, else the first `a.b:` code of its error. */
export function refusalOf(r) {
  let d = null; try { d = JSON.parse(r.stdout); } catch { /* plain */ }
  if (d?.accepted === false) return d.code ?? 'refused';
  if (r.code === 0) return null;
  return CODE.exec(String(r.stderr || r.stdout).replace(/^error: /m, ''))?.[1] ?? `exit.${r.code}`;
}
/** {ok, why} for one run step's output against its expect. */
export function stepVerdict(expect, r) {
  let d = null; try { d = JSON.parse(r.stdout); } catch { /* plain */ }
  const code = refusalOf(r), phase = d?.receipt?.phase;
  if (expect === 'ok') return r.code === 0 ? { ok: true, why: 'exit 0' } : { ok: false, why: `exit ${r.code} ${code ?? ''}`.trim() };
  if (expect === 'accepted') return r.code === 0 && !code && !['failed', 'refused', 'cancelled'].includes(phase) ? { ok: true, why: `accepted${phase ? ` (${phase})` : ''}` } : { ok: false, why: `not accepted: ${code ?? phase ?? `exit ${r.code}`}` };
  if (expect?.refused) return code === expect.refused ? { ok: true, why: `refused ${code}` } : { ok: false, why: `${code ? `refused ${code}` : `not refused (exit ${r.code})`}, not ${expect.refused}` };
  if (expect?.says) return new RegExp(expect.says, 'i').test(`${r.stdout}\n${r.stderr}`) ? { ok: true, why: `says /${expect.says}/` } : { ok: false, why: `does not say /${expect.says}/: ${String(r.stderr || r.stdout).trim().slice(0, 160)}` };
  throw new Error(`unknown expect ${JSON.stringify(expect)}`);
}
export function validateCases(battery) {
  const errs = [];
  if (!Array.isArray(battery?.items) || !battery.items.length) return ['battery.items[] required'];
  for (const [i, c] of battery.items.entries()) {
    const at = `items[${i}]${c?.id ? ` (${c.id})` : ''}`;
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(c?.id ?? '')) errs.push(`${at}.id: lowercase, digits, dashes`);
    if (typeof c?.bar !== 'string' || !c.bar.trim()) errs.push(`${at}.bar: the case's stated bar`);
    if (!Array.isArray(c?.souls) || !c.souls.length) { errs.push(`${at}.souls[] required`); continue; }
    if (c.souls.filter((s) => s.script?.some((st) => st.world)).length > 1) errs.push(`${at}: one Soul's script drives the world`);
    if (c.drive !== undefined && !DRIVE_NAMES.includes(c.drive)) errs.push(`${at}.drive: one of ${DRIVE_NAMES.join(', ')}`);
    for (const [j, s] of c.souls.entries()) {
      const sat = `${at}.souls[${j}]`;
      if (!/^[a-z][a-z0-9-]*$/.test(s?.id ?? '') || typeof s?.name !== 'string') errs.push(`${sat}: id and name required`);
      if (c.drive !== undefined) { if (s.script) errs.push(`${sat}.script: a driven case has none`); continue; }
      if (!Array.isArray(s?.script) || !s.script.length) { errs.push(`${sat}.script[] required`); continue; }
      for (const [k, st] of s.script.entries()) {
        const kat = `${sat}.script[${k}]`;
        if (st.run) { if (!Array.isArray(st.run) || !st.run.every((a) => typeof a === 'string')) errs.push(`${kat}.run: eden.mjs args`); try { stepVerdict(st.expect, { code: 0, stdout: '', stderr: '' }); } catch (e) { errs.push(`${kat}: ${e.message}`); } }
        else if (st.until) { if (st.phase !== 'ended' || !(st.withinSec > 0)) errs.push(`${kat}: until needs phase "ended" and withinSec`); }
        else if (st.world) { if (st.world !== 'restart') errs.push(`${kat}.world: restart`); }
        else if (st.await !== 'restart') errs.push(`${kat}: run, until, world or await`);
        if (st.in && !(s.folders ?? []).includes(st.in)) errs.push(`${kat}.in: ${st.in} is not in this Soul's folders`);
      }
    }
  }
  return errs;
}

/** runCase({dir, base, item, seatCfg, restart, serverRoot}) → the case record (also dir/case.json). restart() stops the world
 *  and starts it again on the same data, resolving once it answers. */
export async function runCase({ dir, base, item, seatCfg, restart = null, serverRoot = null, log = () => {} }) {
  const souls = [], opened = [];   // every folder that may run a `serve`, stopped once however the case ends (as #1989)
  const stopAll = async () => { for (const f of opened.splice(0)) await cli(f, ['serve', '--stop']).catch(() => {}); };
  let relay = null;
  try {
  const hostile = item.drive ? await import('./hostile.mjs') : null;
  if (item.relay) relay = await hostile.startRelay(base);
  const soulBase = relay?.base ?? base;
  for (const s of item.souls) {   // set up together before any script runs
    const seat = createSeat({ runDir: dir, seat: { ...seatCfg, id: s.id }, worldBase: soulBase, rails: {} });
    opened.push(seat.folder);
    const setup = await prepareFolder(seat, { name: s.name });
    const folders = { own: seat.folder };
    for (const f of s.folders ?? []) {
      const p = join(dir, 'seats', `${s.id}-${f}`, 'folder'); mkdirSync(p, { recursive: true }); opened.push(p);
      writeFileSync(join(p, '.eden-agent.json'), JSON.stringify({ identity: seat.info.ownerIdentity }) + '\n', { mode: 0o600 });
      copyFileSync(join(seat.folder, 'eden.mjs'), join(p, 'eden.mjs'));
      const r = await cli(p, ['register', soulBase]); if (r.code !== 0) throw new Error(`${s.id} ${f}: register exited ${r.code}`);
      folders[f] = p;
    }
    souls.push({ spec: s, seat, setup, folders });
  }
  const world = { restartAt: null, restartMs: null, restarted: null };
  let doneRestart; const restarted = new Promise((ok) => { doneRestart = ok; });
  const t0 = Date.now();
  const play = async ({ spec, setup, folders }) => {
    const steps = []; let receipt = null;
    const bind = (args) => args.map((a) => a.replaceAll('{soul}', setup.soulId).replaceAll('{receipt}', receipt ?? '{receipt}'));
    const late = (st, began) => { if (!st.withinSec) return null; const from = st.from === 'restart' ? world.restartAt : began; const s = from == null ? null : (Date.now() - from) / 1000; return s == null ? `no ${st.from} to time from` : s > st.withinSec ? `${Math.round(s)} s after the ${st.from ?? 'step'}, over ${st.withinSec} s` : null; };
    for (const st of spec.script) {
      const began = Date.now(), rec = { at: Math.round((began - t0) / 100) / 10 };
      if (st.world === 'restart') {
        await sleep((st.afterSec ?? 0) * 1000);
        if (!restart) { Object.assign(rec, { world: 'restart', ok: false, why: 'this world cannot be restarted (remote)' }); doneRestart(); steps.push(rec); continue; }
        world.restartAt = Date.now(); log(`${item.id}: restarting the world`);
        try { await restart(); world.restartMs = Date.now() - world.restartAt; world.restarted = true; Object.assign(rec, { world: 'restart', ok: true, why: `back in ${Math.round(world.restartMs / 100) / 10} s` }); }
        catch (e) { world.restarted = false; Object.assign(rec, { world: 'restart', ok: false, why: String(e.message).slice(0, 200) }); }
        doneRestart(); steps.push(rec); continue;
      }
      if (st.await) { await restarted; Object.assign(rec, { await: st.await, ok: !!world.restarted, why: world.restarted ? 'restarted' : 'the restart failed' }); steps.push(rec); continue; }
      const args = bind(st.run ?? st.until), where = folders[st.in ?? 'own'];
      Object.assign(rec, { cmd: args.join(' '), in: st.in ?? null });
      if (args.some((a) => a.includes('{receipt}'))) { Object.assign(rec, { ok: false, why: 'no receipt kept by an earlier step' }); steps.push(rec); continue; }
      let r, v;
      if (st.until) {
        const end = Date.now() + st.withinSec * 1000; let tries = 0;
        for (;;) {
          r = await cli(where, args); tries++;
          let d = null; try { d = JSON.parse(r.stdout); } catch { /* plain */ }
          const phase = d?.phase ?? d?.receipt?.phase ?? null;
          v = ENDED_PHASES.includes(phase) ? { ok: true, why: `${phase}${d?.reason ? `: ${d.reason}` : ''}` } : { ok: false, why: `still ${phase ?? refusalOf(r) ?? 'unknown'} after ${tries} reads` };
          if (v.ok || Date.now() + 2000 > end) break;
          await sleep(2000);
        }
      } else {
        r = await cli(where, args); v = stepVerdict(st.expect, r);
        if (st.keep) { try { receipt = JSON.parse(r.stdout)?.receipt?.id ?? receipt; } catch { /* none */ } }
      }
      const over = v.ok ? late(st, began) : null;
      Object.assign(rec, { exit: r.code, refusal: refusalOf(r), ok: v.ok && !over, why: over ?? v.why, ms: Date.now() - began });
      steps.push(rec);
    }
    return { soul: spec.id, name: spec.name, soulId: setup.soulId, ok: steps.every((x) => x.ok), steps };
  };
  let results, measures = null;
  if (item.drive) ({ results, measures } = await hostile.DRIVES[item.drive]({ dir, base, relay, serverRoot, item, souls, t0, log }));
  else results = await Promise.all(souls.map(play));
  await stopAll();
  const refusals = {};
  const add = (k) => { if (k) refusals[k] = (refusals[k] ?? 0) + 1; };
  for (const x of results) for (const st of x.steps) add(st.refusal);
  const traced = {};
  for (const { spec, seat, setup } of souls) {
    const f = join(runtimeDir(seat.folder, setup.soulId), '.eden-report.jsonl');
    if (existsSync(f)) { mkdirSync(join(dir, 'trace'), { recursive: true }); copyFileSync(f, join(dir, 'trace', `${spec.id}.jsonl`)); }
    for (const [k, v] of Object.entries(refusalCounts(httpSince(readJsonl(f), t0)))) traced[k] = (traced[k] ?? 0) + v;
  }
  const rec = { case: item.id, bar: item.bar, succeeded: results.every((x) => x.ok), why: results.flatMap((x) => x.steps.filter((s) => !s.ok).map((s) => `${x.soul}: ${s.cmd ?? s.world ?? s.await}: ${s.why}`)).join('; ') || 'every check held',
    wallMs: Date.now() - t0, world, refusals, tracedRefusals: traced, ...(measures ? { measures } : {}), souls: results, client: { cli: souls[0]?.setup.cliVersion ?? null, skill: souls[0]?.setup.skillVersion ?? null } };
  writeJson(join(dir, 'case.json'), rec);
  return rec;
  } finally { await stopAll(); await relay?.close(); }
}
