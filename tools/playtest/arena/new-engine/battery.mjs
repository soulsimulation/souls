// A Soul Client eval battery on the new engine (0.135 P2): `soul-eval.mjs run --battery <b> --seat scripted --engine v2`.
// Each item is one episode on its own fresh world of the battery's template (run.sh, world.mjs), as the old run gives each
// its own: one scripted Soul (Wren) paired and joined through the new client, the item's instruction sent as its owner's
// message (the directory's mailbox), the seat answering it by its script (director.mjs's scripted seat), and the item's
// check judged every half second by eval/measure.mjs `judge` on what the world shows:
//   place     the place names up the body's frames in the public stream, as the battery's place ids (`g-<name>`)
//   posture   seated while the body is in a slot
//   receipt   the seat's own acts and their receipts (its command log)
//   card      the owner's message as the mailbox records it (done or failed)
// The result and REPORT.md are the old run's (eval/report.mjs). A step the new client has no verb for is listed under
// the run's `skipped` and in the report, not re-made. Fake minds; nothing is spent.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { writeJson } from '../../lib/jsonl.mjs';
import { sleep } from '../../lib/clock.mjs';
import { judge, summarize, cardClosed } from '../../eval/measure.mjs';
import { renderReport } from '../../eval/report.mjs';
import { newEngineModules } from './director.mjs';

/** The battery's place id for a place name of the new engine (import-eden: today's place id is `g-` and its name). */
export const placeIds = (path) => path.map((n) => `g-${n}`);

/** The seat's acts as receipts (`{capability: "<verb>:<target>", phase}`), from its command log, after `sinceMs`. */
export function receiptsOf(commands, sinceMs, kindOf = () => null) {
  return commands.filter((c) => c.at >= sinceMs && c.words?.[0] === 'act' && c.answer?.receipt).map((c) => {
    const r = c.answer.receipt, verb = String(r.verbs?.[0] ?? '').split(':').at(-1) || 'walk';
    const phase = c.answer.phase === 'done' ? 'completed' : c.answer.phase === 'refused' ? 'refused' : 'started';
    return { id: `${c.at}`, capability: `${verb}:${r.target}`, phase, chosen: { target: r.target }, kind: kindOf(r.target) };
  });
}
const readLines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

/** One item on its own world. → the old run's episode record */
export async function episodeV2({ dir, genesis, item, seatCfg, sampleMs = 500, holdSec = 15, graceSec = 10, log = () => {} }) {
  const mods = newEngineModules({ log });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  await mods.provision.startWorld({ genesis, dataDir: join(dir, 'world') });
  const bootMs = Date.now() - t0;
  const seat = await mods.seat.createSeat({ runDir: dir, seat: { ...seatCfg, id: 'wren', soulName: seatCfg.soulName ?? 'Wren' } });
  try {
    const ob = await seat.onboard();
    if (!ob.ok) throw new Error('the Soul did not join');
    const soulId = ob.soulId, truth = mods.swarmTruth();
    const kinds = (id) => truth.node(id)?.kind ?? null;
    const first = await truth.soul(soulId), before = { place: first.placePath?.[0] ?? null, posture: first.posture };
    seat.wakeLoop();
    const sentLocal = Date.now();
    const sent = await mods.owner.sendCard({ soulId, identity: 'wren', text: item.instruction });
    log(`${item.id}: sent ${sent.messageId}`);
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
      verdict = judge(item.check, { obs, newReceipts, card, catalog: { thingKind: (id) => kindName(kinds(id)), placeKind: () => null }, soulId, calendar: [], sentAt: sentLocal });
      samples.push({ t, place: obs.place, posture: obs.posture, card: card?.state ?? null, ok: verdict.ok });
      const closed = cardClosed(card);
      if (closed && closedAt == null) closedAt = t;
      if (verdict.ok && successAt == null) successAt = t;
      if (!verdict.ok) successAt = null;
      if (verdict.ok && closed) { endedBy = 'success+closed'; break; }
      if (verdict.ok && t - successAt >= (item.holdSec ?? holdSec) * 1000) { endedBy = 'success-held'; break; }
      if (closed && !verdict.ok && t - closedAt >= graceSec * 1000) { endedBy = 'closed-unmet'; break; }
    }
    // the seat's own polls of its owner's messages are its scheduler's, as long polls were: counted apart
    const all = readLines(seat.commands()).filter((c) => c.at >= sentLocal), cmds = all.filter((c) => c.words[0] !== 'pending'), cliCalls = {};
    for (const c of cmds) cliCalls[c.words[0]] = (cliCalls[c.words[0]] ?? 0) + 1;
    const ms = cmds.map((c) => c.ms).filter(Number.isFinite);
    const rec = {
      item: item.id, instruction: item.instruction, engine: 'v2', succeeded: verdict.ok, why: verdict.why, endedBy, sentAt: new Date(sentLocal).toISOString(), wallMs: Date.now() - sentLocal,
      firstMotionMs, successMs: verdict.ok ? successAt : null, cardClosedMs: closedAt, card: card ? { state: card.state, outcome: card.outcome, closed: cardClosed(card) } : null,
      seat: { modelTurns: 0, apiCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, cliCalls }, skipped: [...seat.skipped],
      kickoff: { costUsd: 0 }, worldCalls: cmds.length, longPolls: all.length - cmds.length, routes: [], refusals: {}, clientMsPerCall: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, serverMsPerCall: null,
      client: { cli: 'v2', skill: 'v2' }, samples: samples.length, bootMs,
    };
    writeJson(join(dir, 'episode.json'), rec);
    writeJson(join(dir, 'samples.json'), samples);
    return rec;
  } finally { await seat.stop(); await mods.provision.stopWorld(); }
}

/** The battery's kind name for a new-engine kind (`eden:bench@…` → `core-bench`, as import-eden named today's core kinds). */
export const kindName = (k) => (k ? `core-${String(k).split('@')[0].split(':').at(-1)}` : null);

export async function runBatteryV2({ battery, seatCfg, genesis, out, items: pick = null, repeats = 1, log = () => {} }) {
  if (seatCfg.adapter !== 'scripted-owner') throw new Error('only the scripted seat runs a battery on the new engine (no model runs)');
  out = resolve(out); mkdirSync(out, { recursive: true });
  const items = battery.items.filter((it) => !pick || pick.has(it.id));
  const meta = { schema: 'soul-eval/1', battery: battery.battery, world: `local:${battery.world} (new engine)`, engine: 'v2', deliver: 'inbox', seat: { adapter: 'scripted-owner' },
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
