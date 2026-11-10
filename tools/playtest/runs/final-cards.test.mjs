// #1309: the world's record of every owner message at run end, read live (a stub world) and from kept world data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveredMessages, finalCardsFromDb, readFinalCards, readFinalCardsFile, writeFinalCards } from './final-cards.mjs';

const TOKEN = 'sim_s_ada_planted-token-0123456789abcdef', BASE = 'http://127.0.0.1:4999';
function playtest(t) {
  const d = mkdtempSync(join(tmpdir(), 'final-cards-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, 'director'), { recursive: true }); mkdirSync(join(d, 'seats', 'ada', 'folder'), { recursive: true }); mkdirSync(join(d, 'seats', 'bo'), { recursive: true });
  const rows = [
    { seat: 'ada', requestId: 'ada-001', messageId: 'msg_a', text: 'walk to the mill' },
    { seat: 'ada', requestId: 'ada-002', messageId: 'msg_b', text: 'the pond instead' },
    { seat: 'ada', requestId: 'ada-003', messageId: 'msg_c', text: 'how are you?' },
    { seat: 'ada', requestId: 'ada-004', messageId: 'msg_gone', text: 'too old' },
    { seat: 'ada', requestId: 'ada-002', messageId: 'msg_b', text: 'repeated row' },
    { seat: 'ada', kind: 'nudge', text: 'no message id' },
    { seat: 'bo', requestId: 'bo-001', messageId: 'msg_d', text: 'sit down' },
  ];
  writeFileSync(join(d, 'director', 'directions.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(d, 'seats', 'ada', 'folder', '.eden-agent.json'), JSON.stringify({ world: BASE, token: TOKEN }));
  return d;
}
const WORLD = {
  msg_a: { id: 'msg_a', state: 'acknowledged', outcome: 'failed', result: 'walk:mill was replaced by a newer act before it finished.', resultAt: 50, resultBy: 'server', acknowledgedAt: 10 },
  msg_b: { id: 'msg_b', state: 'acknowledged', outcome: 'done', result: 'At the pond', resultAt: 40, acknowledgedAt: 21 },
  msg_c: { id: 'msg_c', state: 'acknowledged', acknowledgedAt: 31 },
};

test('every delivered message is read once, as its seat, and a failed read is recorded, never guessed', async (t) => {
  const d = playtest(t), asked = [];
  assert.deepEqual(deliveredMessages(d).map((r) => r.messageId), ['msg_a', 'msg_b', 'msg_c', 'msg_gone', 'msg_d']);
  const fetchFn = async (url, init) => {
    asked.push(url); assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    const m = WORLD[decodeURIComponent(url.split('/').at(-1))];
    return m ? { ok: true, status: 200, json: async () => ({ message: m }) } : { ok: false, status: 404, json: async () => ({}) };
  };
  const doc = writeFinalCards(d, await readFinalCards({ base: BASE, playtestDir: d, fetchFn, now: () => 'T' }));
  assert.equal(asked.length, 4, 'bo has no credentials, so nothing is asked for him');
  assert.deepEqual(doc.summary, { delivered: 5, read: 3, unread: 2, closed: 2, open: 1, closedBy: { agent: 1, server: 1 }, outcome: { done: 1, failed: 1, other: 0 } });
  const by = Object.fromEntries(doc.cards.map((c) => [c.messageId, c]));
  assert.deepEqual(by.msg_a, { seat: 'ada', requestId: 'ada-001', messageId: 'msg_a', found: true, state: 'acknowledged', closed: true, outcome: 'failed', closedBy: 'server', resultAt: 50, acknowledgedAt: 10 });
  assert.equal(by.msg_c.closed, false); assert.equal(by.msg_gone.why, 'http 404'); assert.equal(by.msg_d.why, 'no seat credentials');
  const written = readFileSync(join(d, 'final-cards.json'), 'utf8');
  for (const leak of [TOKEN, BASE, '127.0.0.1', 'walk to the mill', 'At the pond']) assert.ok(!written.includes(leak), `not written: ${leak}`);
  assert.deepEqual(readFinalCardsFile(d).summary, doc.summary);
});

test('a world that throws or never answers leaves a record per message, and nothing escapes', async (t) => {
  const d = playtest(t);
  const doc = await readFinalCards({ base: BASE, playtestDir: d, fetchFn: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } });
  assert.equal(doc.summary.read, 0); assert.ok(doc.cards.filter((c) => c.seat === 'ada').every((c) => c.why === 'read failed: TimeoutError'));
});

test('a finished run\'s kept world data gives the same cards, read-only (#1309 A2)', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const d = playtest(t), data = join(d, 'server', 'data'); mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, 'sim.db'));
  db.exec('CREATE TABLE soul_inbox_queue_v1 (world_id TEXT, scope TEXT, owner TEXT, n INTEGER, id TEXT, text TEXT, sent_at INTEGER, delivered_at INTEGER, acknowledged_at INTEGER, reply TEXT, outcome TEXT, touched TEXT, focus TEXT, result TEXT, result_at INTEGER, result_by TEXT, progress TEXT)');
  const ins = db.prepare('INSERT INTO soul_inbox_queue_v1 (id, text, sent_at, delivered_at, acknowledged_at, outcome, result, result_at, result_by) VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run('msg_a', 'walk to the mill', 1, 2, 10, 'failed', 'replaced', 50, 'server'); ins.run('msg_b', 'the pond instead', 3, 4, 21, 'done', 'At the pond', 40, null);
  ins.run('msg_c', 'how are you?', 5, 6, 31, null, null, null, null); ins.run('msg_d', 'sit down', 7, 8, null, null, null, null, null);
  db.close();
  const doc = await finalCardsFromDb({ dataDir: data, playtestDir: d });
  assert.deepEqual(doc.summary, { delivered: 5, read: 4, unread: 1, closed: 2, open: 2, closedBy: { agent: 1, server: 1 }, outcome: { done: 1, failed: 1, other: 0 } });
  const by = Object.fromEntries(doc.cards.map((c) => [c.messageId, c]));
  assert.deepEqual([by.msg_a.closedBy, by.msg_b.closedBy, by.msg_d.state, by.msg_gone.why], ['server', 'agent', 'delivered', 'not in the world data']);
});
