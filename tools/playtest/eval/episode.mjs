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

const cli = async (folder, args, maxWallMs = 60000) => {
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
  if (resetTo) { const r = await cli(seat.folder, ['act', `walk:${resetTo}`, '--wait', '60'], 120000); log(`${item.id}: reset to ${resetTo}: ${r.data?.receipt?.phase ?? r.data?.code ?? r.code}`); await cli(seat.folder, ['stop']).catch(() => {}); }
  // A client before 2.25 keeps no world copy; it is then checked and judged against a saved copy of the same template's
  // catalog (--catalog), never against nothing.
  const own = readCatalog(seat.folder, setup.soulId), catalogFrom = own ? 'client' : catalogRef ? 'reference' : null;
  if (!catalogFrom) { await cli(seat.folder, ['serve', '--stop']).catch(() => {}); throw new Error('the client keeps no world copy (world-catalog.json); pass --catalog <a saved copy of this template\'s catalog>'); }
  const catalog = catalogIndex(own ?? catalogRef);
  const bad = validateBattery({ items: [item] }, catalog);   // the battery is checked against this world's own catalog first
  if (bad.length) { await cli(seat.folder, ['serve', '--stop']).catch(() => {}); throw new Error(bad.join('; ')); }
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
  let cap; await Promise.race([seat.stop(), new Promise((ok) => { cap = setTimeout(ok, (rails.maxTurnWallSec ?? 240) * 1000 + 5000); })]); clearTimeout(cap);
  await cli(seat.folder, ['serve', '--stop']).catch(() => {});

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
}
