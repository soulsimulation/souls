// A Soul Client eval battery on the new engine (0.135 P2): `soul-eval.mjs run --battery <b> --seat scripted --engine v2`.
// Each item is one episode on its own fresh world of the battery's template (run.sh, world.mjs), as the old run gives each
// its own: one scripted Soul (Wren) paired and joined through the new client, the item's instruction sent as its owner's
// message (the directory's mailbox), the seat answering it by its script (director.mjs's scripted seat), and the item's
// check judged every half second by eval/measure.mjs `judge` on what the world shows:
//   place     the place names up the body's frames in the public stream, as the battery's place ids (`g-<name>`)
//   posture   seated while the body is in a slot
//   receipt   the seat's own acts and their receipts (its command log)
//   card      the owner's message as the mailbox records it (done or failed)
//   calendar  the posted notices in the public stream and who is coming to each (their `interested` links)
// An item's `board` is a notice board placed in its world's genesis (the new engine's calendar is notices taken from a
// board); its `calendar` is announced there before the instruction by a second scripted Soul (`by`), which takes a
// blank notice, writes it and puts it up with the new client's `calendar add`.
// The result and REPORT.md are the old run's (eval/report.mjs). A step the new client has no verb for is listed under
// the run's `skipped` and in the report, not re-made. Fake minds in the world. A live seat (`--seat
// eval/seats/claude-sonnet.json`, 0.133 Q1) is a real agent through the same client (live.mjs), on the existing Claude
// login: each episode records its world intents and their refusals by cause.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { writeJson } from '../../lib/jsonl.mjs';
import { sleep } from '../../lib/clock.mjs';
import { judge, summarize, cardClosed } from '../../eval/measure.mjs';
import { renderReport } from '../../eval/report.mjs';
import { newEngineModules, placeIn } from './director.mjs';
import { exportFacts } from './world.mjs';
import { liveSeat, intentsOf, useSeatLogin } from './live.mjs';

/** The battery's place id for a place name of the new engine (import-eden: today's place id is `g-` and its name). */
export const placeIds = (path) => path.map((n) => `g-${n}`);

/** The seat's acts as receipts (`{capability: "<verb>:<target>", phase}`), from its command log, after `sinceMs`. */
export function receiptsOf(commands, sinceMs, kindOf = () => null) {
  return commands.filter((c) => c.at >= sinceMs && c.words?.[0] === 'act' && c.answer?.receipt).map((c) => {
    // a ranked list's receipt names every candidate's target, space-separated: the first is the one judged (Q1)
    const r = { ...c.answer.receipt, target: String(c.answer.receipt.target ?? '').split(' ')[0] }, verb = String(r.verbs?.[0] ?? '').split(':').at(-1) || 'walk';
    const phase = c.answer.phase === 'done' ? 'completed' : c.answer.phase === 'refused' ? 'refused' : 'started';
    return { id: `${c.at}`, capability: `${verb}:${r.target}`, phase, chosen: { target: r.target }, kind: kindOf(r.target) };
  });
}
const readLines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

/** A notice board (`eden:notice_board`, content/kinds/calendar/notice_board.json) added to a genesis's facts:
 *  `board`: {name, at: [x, z] in metres, yaw degrees}. → the facts with it */
export function placeBoard(facts, board) {
  const ref = 'eden-notice-board@1';
  if (!facts.kinds.some((k) => k.ref === ref)) facts.kinds.push({ ref, hash: Buffer.from('souls/playtest/notice-board').toString('hex').padEnd(64, '0').slice(0, 64), name: 'eden:notice_board', form: 'point' });
  const [x, z] = (board.at ?? [0, 0]).map((m) => Math.round(m * 1000)), yaw = Math.round((board.yaw ?? 0) * 1000);
  facts.things.push({ id: `e_notice_board_${facts.things.filter((t) => t.ref === ref).length + 1}`, def: ref, ref, parent: null, pose: [x, 0, z, yaw], world: [x, 0, z, yaw], scale_ppm: 1_000_000, name: board.name ?? 'notice board', slots: [] });
  return facts;
}

/** The item's calendar announced by a second scripted Soul: paired, joined, `calendar add` at the item's place (found
 *  in its copy; the board where there is no such place), and its `posted` event waited for. → the notice's id */
async function announce({ by, cal, log, ms = 240_000 }) {
  const ob = await by.onboard();
  if (!ob.ok) throw new Error(`${cal.by}: did not join`);
  const until = Date.now() + ms;
  let board = null;
  while (!board && Date.now() < until) { board = ((await by.cli('find', 'notice', 'board')).found ?? []).find((r) => r.kind?.startsWith('eden:notice_board')) ?? null; if (!board) await sleep(1000); }
  if (!board) throw new Error(`${cal.by}: no notice board in its copy`);
  const place = cal.place ? (await placeIn(by, String(cal.place).replace(/^g-/, '')))?.id ?? board.id : board.id;
  const add = await by.cli('calendar', 'add', cal.title, '--place', place, '--in', String(cal.inMinutes ?? 20), '--for', String(cal.forMinutes ?? 30));
  if (add.ok !== true) throw new Error(`${cal.by}: calendar add refused ${add.code ?? JSON.stringify(add).slice(0, 200)}`);
  while (Date.now() < until) {
    const e = ((await by.cli('wait', '20')).events ?? []).find((x) => x.kind === 'calendar');
    if (e?.what === 'posted') { log(`${cal.by} posted ${e.item} (${cal.title})`); return e.item; }
    if (e) throw new Error(`${cal.by}: the notice was not put up: ${e.step ?? ''} ${e.detail ?? ''}`);
  }
  throw new Error(`${cal.by}: no calendar event in ${ms / 1000} s`);
}

/** One item on its own world. → the old run's episode record */
export async function episodeV2({ dir, genesis, item, seatCfg, sampleMs = 500, holdSec = 15, graceSec = 10, log = () => {} }) {
  const mods = newEngineModules({ log });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let facts = null;
  if (item.board) {
    facts = exportFacts(genesis, join(dir, 'genesis.facts.json'));
    writeFileSync(facts, JSON.stringify(placeBoard(JSON.parse(readFileSync(facts, 'utf8')), item.board)));
  }
  await mods.provision.startWorld({ genesis, facts, dataDir: join(dir, 'world') });
  const bootMs = Date.now() - t0;
  // 0.133 Q1: a live seat (claude-headless) is a real agent through the same client (live.mjs); else the scripted one
  const live = seatCfg.adapter === 'claude-headless';
  const seat = live ? await liveSeat({ world: mods.world(), dir, model: seatCfg.model ?? 'sonnet', effort: seatCfg.effort ?? null, maxWallSec: item.timeoutSec ?? 240, log })
    : await mods.seat.createSeat({ runDir: dir, seat: { ...seatCfg, id: 'wren', soulName: seatCfg.soulName ?? 'Wren' } });
  let other = null;
  try {
    const ob = await seat.onboard();
    if (!ob.ok) throw new Error('the Soul did not join');
    if (live) mods.track(ob.soulId, ob.body);
    const soulId = ob.soulId, truth = mods.swarmTruth();
    const kinds = (id) => truth.node(id)?.kind ?? null;
    const first = await truth.soul(soulId), before = { place: first.placePath?.[0] ?? null, posture: first.posture };
    // "the first thing" the calendar lists for the next hour when the instruction goes: the one notice announced, once
    // the public stream shows it posted
    let calendarFirst = null;
    if (item.calendar) {
      const by = String(item.calendar.by ?? 'Moss');
      other = { seat: await mods.seat.createSeat({ runDir: dir, seat: { adapter: 'scripted-owner', id: by.toLowerCase(), soulName: by, script: { rules: [] } } }) };
      other.item = await announce({ by: other.seat, cal: item.calendar, log });
      const until = Date.now() + 60_000;
      while (!truth.calendar().some((c) => c.id === other.item) && Date.now() < until) await sleep(sampleMs);
      if (!truth.calendar().some((c) => c.id === other.item)) throw new Error(`${other.item}: posted, but not in the public stream in 60 s`);
      calendarFirst = other.item;
    }
    seat.wakeLoop();
    const sentLocal = Date.now();
    const sent = await mods.owner.sendCard({ soulId, identity: 'wren', text: item.instruction });
    log(`${item.id}: sent ${sent.messageId}`);
    if (live) seat.deliver({ id: sent.messageId, text: item.instruction });
    const deadline = sentLocal + (item.timeoutSec ?? 240) * 1000;
    let verdict = { ok: false, why: 'timeout' }, card = null, successAt = null, closedAt = null, firstMotionMs = null, endedBy = 'timeout';
    const samples = [];
    while (Date.now() < deadline) {
      await sleep(sampleMs);
      const tr = await truth.soul(soulId), view = await mods.owner.cardView({ soulId, identity: 'wren' });
      const m = (view.messages ?? []).find((x) => x.id === sent.messageId) ?? null;
      card = m ? { messageId: m.id, state: m.state, outcome: ['done', 'failed'].includes(m.state) ? m.state : null } : null;
      const obs = { placeIds: placeIds(tr.placePath ?? []), place: tr.placePath?.[0] ? `g-${tr.placePath[0]}` : null, posture: tr.posture ?? null, receipts: [] };
      const t = Date.now() - sentLocal;
      if (firstMotionMs == null && (tr.placePath?.[0] ?? null) !== before.place) firstMotionMs = t;
      const newReceipts = receiptsOf(readLines(seat.commands()), sentLocal);
      verdict = judge(item.check, { obs, newReceipts, card, catalog: { thingKind: (id) => kindName(kinds(id)), placeKind: () => null }, soulId, calendar: item.calendar ? truth.calendar() : [], calendarFirst, sentAt: sentLocal });
      samples.push({ t, place: obs.place, posture: obs.posture, card: card?.state ?? null, ok: verdict.ok });
      const closed = cardClosed(card);
      if (closed && closedAt == null) closedAt = t;
      if (verdict.ok && successAt == null) successAt = t;
      if (!verdict.ok) successAt = null;
      if (verdict.ok && closed) { endedBy = 'success+closed'; break; }
      if (verdict.ok && t - successAt >= (item.holdSec ?? holdSec) * 1000) { endedBy = 'success-held'; break; }
      if (closed && !verdict.ok && t - closedAt >= graceSec * 1000) { endedBy = 'closed-unmet'; break; }
    }
    if (live) await seat.settle();   // the agent's turn ends (its last report and ack) before its commands are counted
    // the seat's own polls of its owner's messages are its scheduler's, as long polls were: counted apart
    const all = readLines(seat.commands()).filter((c) => c.at >= sentLocal), cmds = all.filter((c) => c.words[0] !== 'pending'), cliCalls = {};
    for (const c of cmds) cliCalls[c.words[0]] = (cliCalls[c.words[0]] ?? 0) + 1;
    const ms = cmds.map((c) => c.ms).filter(Number.isFinite);
    const intents = intentsOf(cmds), refusals = {};
    for (const i of intents) if (i.end === 'refused') refusals[i.cause] = (refusals[i.cause] ?? 0) + 1;
    const rec = {
      item: item.id, instruction: item.instruction, engine: 'v2', succeeded: verdict.ok, why: verdict.why, endedBy, sentAt: new Date(sentLocal).toISOString(), wallMs: Date.now() - sentLocal,
      firstMotionMs, successMs: verdict.ok ? successAt : null, cardClosedMs: closedAt, card: card ? { state: card.state, outcome: card.outcome, closed: cardClosed(card) } : null,
      seat: live ? { adapter: 'claude-headless', model: seat.info.model, modelTurns: seat.usage.turns, apiCalls: 0, tokensIn: seat.usage.tokensIn, tokensOut: seat.usage.tokensOut, costUsd: seat.usage.costUsd, denied: seat.usage.denied, cliCalls }
        : { modelTurns: 0, apiCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, cliCalls }, skipped: [...seat.skipped],
      kickoff: { costUsd: 0 }, worldCalls: cmds.length, longPolls: all.length - cmds.length, routes: [], refusals, intents, clientMsPerCall: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, serverMsPerCall: null,
      client: { cli: 'v2', skill: 'v2' }, samples: samples.length, bootMs, ...(calendarFirst ? { calendarFirst } : {}),
    };
    writeJson(join(dir, 'episode.json'), rec);
    writeJson(join(dir, 'samples.json'), samples);
    return rec;
  } finally { await seat.stop(); await other?.seat.stop(); await mods.provision.stopWorld(); }
}

/** The battery's kind name for a new-engine kind (`eden:bench@…` → `core-bench`, as import-eden named today's core kinds). */
export const kindName = (k) => (k ? `core-${String(k).split('@')[0].split(':').at(-1)}` : null);

export async function runBatteryV2({ battery, seatCfg, genesis, out, items: pick = null, repeats = 1, log = () => {} }) {
  if (!['scripted-owner', 'claude-headless'].includes(seatCfg.adapter)) throw new Error('a battery on the new engine runs the scripted seat or a live claude-headless one');
  out = resolve(out); mkdirSync(out, { recursive: true });
  if (seatCfg.adapter === 'claude-headless') useSeatLogin();
  const items = battery.items.filter((it) => !pick || pick.has(it.id));
  const meta = { schema: 'soul-eval/1', battery: battery.battery, world: `local:${battery.world} (new engine)`, engine: 'v2', deliver: 'inbox', seat: { adapter: seatCfg.adapter, model: seatCfg.model ?? null },
    repeats, warmSec: 0, items: items.map((i) => i.id), maxUsd: 0, startedAt: new Date().toISOString() };
  writeJson(join(out, 'run.json'), meta);
  const episodes = []; let n = 0;
  for (let rep = 1; rep <= repeats; rep++) for (const item of items) {
    const dir = join(out, 'episodes', `${String(++n).padStart(3, '0')}-${item.id}-r${rep}`);
    try {
      const rec = await episodeV2({ dir, genesis, item, seatCfg, log });
      rec.repeat = rep; episodes.push(rec);
      log(`${item.id} r${rep}: ${rec.succeeded ? 'PASS' : 'FAIL'} (${rec.why})${rec.skipped.length ? `; skipped: ${rec.skipped.join('; ')}` : ''}`);
    } catch (e) {
      log(`${item.id} r${rep}: ERROR ${e.message}`);
      episodes.push({ item: item.id, repeat: rep, error: String(e.message).slice(0, 300), succeeded: false, seat: { modelTurns: 0, apiCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, cliCalls: {} }, refusals: {}, routes: [] });
    }
  }
  const skipped = [...new Set(episodes.flatMap((e) => (e.skipped ?? []).map((s) => `${e.item}: ${s}`)))];
  const result = { ...meta, endedAt: new Date().toISOString(), stoppedBy: null, spentUsd: 0, skipped, episodes, summary: summarize(episodes.filter((e) => !e.error)) };
  writeJson(join(out, 'result.json'), result);
  const report = renderReport(result) + (skipped.length ? `\n## Steps with no new-engine verb (listed and skipped)\n\n${skipped.map((s) => `- ${s}`).join('\n')}\n` : '');
  writeFileSync(join(out, 'REPORT.md'), report);
  return { out, result, report };
}
