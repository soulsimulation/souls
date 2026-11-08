// The world's own record of every owner message at the end of a Soul Run (#1309): state, outcome, who closed it, when.
// The seat's CLI calls show only the closes the seat saw, and evidence packs stop at the next owner message; since #1299
// the world closes some messages later itself (a replaced act's, a linked act's at its end), so only the world can say
// what was left open. Written to <playtestDir>/final-cards.json. No token, URL or message text is written.
//   live:    readFinalCards({ base, playtestDir })      GET /v1/edge/inbox/:id with each seat's own credentials
//   offline: finalCardsFromDb({ dataDir, playtestDir }) a finished run's kept world data, read-only
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonl } from '../lib/jsonl.mjs';

export const FINAL_CARDS_SCHEMA = 'soul-run-final-cards/1';
export const FINAL_CARDS_FILE = 'final-cards.json';

/** The owner messages the director delivered, from its directions log: one row per message id, in order. */
export function deliveredMessages(playtestDir) {
  const seen = new Set(), out = [];
  for (const d of readJsonl(join(playtestDir, 'director', 'directions.jsonl'))) {
    if (!d?.messageId || !d.seat || seen.has(d.messageId)) continue;
    seen.add(d.messageId); out.push({ seat: d.seat, requestId: d.requestId ?? null, messageId: d.messageId });
  }
  return out;
}

/** One card from the world's message (inbox.ts InboxMessage): closed means it has a result. */
export function cardOf(row, m) {
  const closed = m?.result != null || m?.outcome != null;
  return {
    seat: row.seat, requestId: row.requestId, messageId: row.messageId, found: true, state: m.state ?? null,
    closed, outcome: m.outcome ?? null, closedBy: closed ? (m.resultBy === 'server' ? 'server' : 'agent') : null,
    resultAt: m.resultAt ?? null, acknowledgedAt: m.acknowledgedAt ?? null,
  };
}
const missingCard = (row, why) => ({ seat: row.seat, requestId: row.requestId, messageId: row.messageId, found: false, why });

function summary(cards) {
  const read = cards.filter((c) => c.found), closed = read.filter((c) => c.closed);
  const count = (f) => closed.filter(f).length;
  return {
    delivered: cards.length, read: read.length, unread: cards.length - read.length, closed: closed.length, open: read.length - closed.length,
    closedBy: { agent: count((c) => c.closedBy === 'agent'), server: count((c) => c.closedBy === 'server') },
    outcome: { done: count((c) => c.outcome === 'done'), failed: count((c) => c.outcome === 'failed'), other: count((c) => !['done', 'failed'].includes(c.outcome)) },
  };
}
export const finalCardsDoc = (source, cards, readAt) => ({ schema: FINAL_CARDS_SCHEMA, source, readAt, summary: summary(cards), cards });

/** The seat's own credentials (the CLI's folder file). Read here, never written anywhere. */
function seatToken(playtestDir, seat) {
  try { return JSON.parse(readFileSync(join(playtestDir, 'seats', seat, 'folder', '.eden-agent.json'), 'utf8')).token ?? null; } catch { return null; }
}

/** Live: ask the world about each delivered message, as that seat. A failed read is recorded, never guessed, never thrown. */
export async function readFinalCards({ base, playtestDir, fetchFn = fetch, timeoutMs = 5000, now = () => new Date().toISOString() }) {
  const cards = [];
  for (const row of deliveredMessages(playtestDir)) {
    const token = seatToken(playtestDir, row.seat);
    if (!token) { cards.push(missingCard(row, 'no seat credentials')); continue; }
    try {
      const r = await fetchFn(`${base}/v1/edge/inbox/${encodeURIComponent(row.messageId)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { cards.push(missingCard(row, `http ${r.status}`)); continue; }
      const m = (await r.json())?.message;
      cards.push(m ? cardOf(row, m) : missingCard(row, 'no message in the answer'));
    } catch (e) { cards.push(missingCard(row, `read failed: ${String(e?.name ?? e).slice(0, 60)}`)); }
  }
  return finalCardsDoc('world api at run end', cards, now());
}

/** Offline: the same cards from a finished run's world data, opened read-only. */
export async function finalCardsFromDb({ dataDir, playtestDir, file = 'sim.db' }) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dataDir, file), { readOnly: true });
  try {
    const get = db.prepare('SELECT id, acknowledged_at, delivered_at, outcome, result, result_at, result_by FROM soul_inbox_queue_v1 WHERE id = ?');
    const cards = deliveredMessages(playtestDir).map((row) => {
      const r = get.get(row.messageId);
      if (!r) return missingCard(row, 'not in the world data');
      return cardOf(row, {
        state: r.acknowledged_at != null ? 'acknowledged' : r.delivered_at != null ? 'delivered' : 'sent',
        ...(r.acknowledged_at != null && r.outcome ? { outcome: r.outcome } : {}), ...(r.result != null ? { result: r.result } : {}),
        ...(r.result_at != null ? { resultAt: r.result_at } : {}), ...(r.result_by === 'server' ? { resultBy: 'server' } : {}),
        ...(r.acknowledged_at != null ? { acknowledgedAt: r.acknowledged_at } : {}),
      });
    });
    return finalCardsDoc('world data after the run, read-only', cards, null);
  } finally { db.close(); }
}

export function writeFinalCards(playtestDir, d) { writeFileSync(join(playtestDir, FINAL_CARDS_FILE), JSON.stringify(d, null, 1) + '\n'); return d; }
export function readFinalCardsFile(playtestDir) {
  const f = join(playtestDir, FINAL_CARDS_FILE);
  if (!existsSync(f)) return null;
  try { const d = JSON.parse(readFileSync(f, 'utf8')); return d?.schema === FINAL_CARDS_SCHEMA ? d : null; } catch { return null; }
}

// CLI: node tools/playtest/runs/final-cards.mjs <runDir> [--data <worldDataDir>]: writes <runDir>/playtest/final-cards.json from
// the run's kept world data (default <runDir>/playtest/server/data), for a run that finished before #1309.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const runDir = process.argv[2]; if (!runDir) { console.error('usage: final-cards.mjs <runDir> [--data <dir>]'); process.exit(2); }
  const i = process.argv.indexOf('--data'), playtestDir = join(runDir, 'playtest');
  const d = await finalCardsFromDb({ dataDir: i > 0 ? process.argv[i + 1] : join(playtestDir, 'server', 'data'), playtestDir });
  writeFinalCards(playtestDir, d); console.log(JSON.stringify(d.summary));
}
