// node --test tools/world-launcher/usage.test.mjs — #1942: the site's daily usage table and the operator's report.
// Two fixture world stores across three UTC days, rolled up by usage.mjs in a child process, then read back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Registry } from './registry.mjs';
import { formatReport, missedDays, rollupDay, usageReport } from './usage.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)), SCRIPT = fileURLToPath(new URL('./usage.mjs', import.meta.url));
mkdirSync(join(ROOT, '.local'), { recursive: true });
const dir = mkdtempSync(join(ROOT, '.local', 'usage-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const [D1, D2, D3] = ['2026-11-01', '2026-11-02', '2026-11-03'];
const at = (day, hh) => Date.parse(`${day}T${hh}:00:00Z`);

const reg = new Registry(dir);
for (const slug of ['a', 'b', 'gone']) reg.add({ slug, name: slug, createdAt: 1 });
function world(slug, { souls, acts, refusals, clients }) {
  mkdirSync(reg.worldDir(slug), { recursive: true });
  const file = join(reg.worldDir(slug), 'sim.db'), db = new DatabaseSync(file);
  db.exec(`CREATE TABLE souls (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE edge_receipts_v1 (world_id TEXT, receipt_id TEXT, soul_id TEXT, capability TEXT, phase TEXT, accepted_tick INTEGER, created_at INTEGER);
    CREATE TABLE edge_refusals_v1 (world_id TEXT, at INTEGER, tick INTEGER, soul_id TEXT, verb TEXT, capability TEXT, code TEXT);
    CREATE TABLE edge_clients_v1 (soul_id TEXT, client TEXT, day TEXT, first_at INTEGER, last_at INTEGER, n INTEGER, PRIMARY KEY (soul_id, client, day));`);
  for (const [id, owner] of souls) db.prepare('INSERT INTO souls VALUES (?,?,?,?)').run(id, slug, owner, `Name of ${id}`);
  acts.forEach(([soul, t], i) => db.prepare("INSERT INTO edge_receipts_v1 VALUES (?,?,?,'walk:here','completed',1,?)").run(slug, `r${i}`, soul, t));
  for (const [soul, t, code] of refusals) db.prepare("INSERT INTO edge_refusals_v1 VALUES (?,?,1,?,'walk','walk:here',?)").run(slug, t, soul, code);
  for (const [soul, client, day, first, last, n] of clients) db.prepare('INSERT INTO edge_clients_v1 VALUES (?,?,?,?,?,?)').run(soul, client, day, first, last, n);
  db.close(); return file;
}
world('a', {
  souls: [['s1', 'u1'], ['s2', 'u2']],
  acts: [['s1', at(D1, '09')], ['s1', at(D1, '11')], ['s1', at(D2, '10')], ['s2', at(D3, '08')]],
  refusals: [['s1', at(D2, '10'), 'walk.stuck'], ['s1', at(D2, '11'), 'walk.stuck'], ['s2', at(D3, '09'), 'no-room']],
  clients: [['s1', 'eden/1.0', D1, at(D1, '08'), at(D1, '12'), 5], ['s1', 'eden/1.0', D2, at(D2, '09'), at(D2, '10'), 2], ['s1', 'eden/1.1', D2, at(D2, '11'), at(D2, '12'), 3], ['s2', 'none', D3, at(D3, '08'), at(D3, '08'), 1]],
});
const fileB = world('b', {
  souls: [['s3', 'u1']],
  acts: [['s3', at(D3, '10')], ['s3', at(D3, '11')], ['s3', at(D3, '12')]],
  refusals: [['s3', at(D3, '10'), 'walk.stuck'], ['s3', at(D3, '11'), 'hands.full']],
  clients: [['s3', 'eden/1.1', D3, at(D3, '10'), at(D3, '12'), 4]],
});
const usageFile = join(dir, 'usage.sqlite');
const rollup = (day) => JSON.parse(execFileSync(process.execPath, [SCRIPT, '--data', dir, '--day', day, '--tries', '2', '--wait-ms', '10'], { encoding: 'utf8' }));
const rows = (file = usageFile) => { const db = new DatabaseSync(file, { readOnly: true }); try { return { daily: db.prepare('SELECT * FROM usage_daily ORDER BY day, world, soul').all(), refusals: db.prepare('SELECT * FROM usage_refusals ORDER BY day, world, code').all(), worlds: db.prepare('SELECT day, world, status FROM usage_worlds ORDER BY day, world').all() }; } finally { db.close(); } };
const plain = (x) => JSON.parse(JSON.stringify(x));

test('A1: the child process rolls each day up per Soul; running a day twice gives the same rows', () => {
  for (const d of [D1, D2, D3]) assert.deepEqual(rollup(d).days[0].read, ['a', 'b']);
  const first = plain(rows());
  assert.deepEqual(first.daily.find((r) => r.day === D2 && r.soul === 's1'), { day: D2, world: 'a', account: 'u1', soul: 's1', acts: 1, refusals: 2, requests: 5, last_client: 'eden/1.1', first_at: at(D2, '09'), last_at: at(D2, '12') });
  assert.deepEqual(first.daily.filter((r) => r.day === D3).map((r) => [r.world, r.soul, r.account, r.acts, r.refusals, r.requests, r.last_client]), [['a', 's2', 'u2', 1, 1, 1, 'none'], ['b', 's3', 'u1', 3, 2, 4, 'eden/1.1']]);
  assert.deepEqual(first.refusals.map((r) => [r.day, r.world, r.code, r.n]), [[D2, 'a', 'walk.stuck', 2], [D3, 'a', 'no-room', 1], [D3, 'b', 'hands.full', 1], [D3, 'b', 'walk.stuck', 1]]);
  assert.equal(first.daily.length, 4);
  for (const d of [D1, D2, D3]) rollup(d);
  assert.deepEqual(plain(rows()), first);
});

test('A2: a missing world and one still busy are skipped for the day, never zeros; a busy one is retried; missed days are filled', async () => {
  assert.deepEqual(rows().worlds.filter((r) => r.world === 'gone').map((r) => r.status), ['skipped', 'skipped', 'skipped']);
  assert.ok(!rows().daily.some((r) => r.world === 'gone'));
  const lock = new DatabaseSync(fileB); lock.exec('BEGIN EXCLUSIVE');
  try {
    // still busy after every try: skipped, no rows for b that day
    const fresh = join(dir, 'busy.sqlite');
    const r = await rollupDay(fresh, [{ slug: 'b', file: fileB }], D3, { tries: 2, waitMs: 10 });
    assert.equal(r.skipped[0]?.world, 'b'); assert.match(r.skipped[0].reason, /locked|busy/i);
    assert.deepEqual(plain(rows(fresh)), { daily: [], refusals: [], worlds: [{ day: D3, world: 'b', status: 'skipped' }] });
    // an earlier good read of that day stands
    await rollupDay(usageFile, [{ slug: 'b', file: fileB }], D3, { tries: 1 });
    assert.equal(rows().worlds.find((x) => x.day === D3 && x.world === 'b').status, 'read');
    assert.equal(rows().daily.filter((x) => x.day === D3 && x.world === 'b').length, 1);
    // busy, then free before the next try: read
    setTimeout(() => lock.exec('COMMIT'), 30);
    const again = await rollupDay(fresh, [{ slug: 'b', file: fileB }], D3, { tries: 3, waitMs: 100 });
    assert.deepEqual(again.read, ['b']);
    assert.equal(rows(fresh).daily.length, 1);
  } finally { if (lock.isTransaction) lock.exec('ROLLBACK'); lock.close(); }
  // fill: after the last rolled-up day through yesterday; with no history, yesterday only
  const one = join(dir, 'fill.sqlite');
  await rollupDay(one, [{ slug: 'a', file: join(reg.worldDir('a'), 'sim.db') }], D1);
  assert.deepEqual(missedDays(one, at('2026-11-04', '12')), [D2, D3]);
  assert.deepEqual(missedDays(one, at('2026-11-02', '12')), []);
  assert.deepEqual(missedDays(join(dir, 'none.sqlite'), at('2026-11-04', '12')), [D3]);
});

test('A3: the report per day and per account, test worlds left out, and op.mjs usage prints it', async () => {
  const r = usageReport(usageFile, { days: 3 });
  assert.deepEqual(r.days.map((d) => [d.day, d.accounts, d.newAccounts, d.returningAccounts, d.souls, d.acts, d.refusals]), [[D1, 1, 1, 0, 1, 2, 0], [D2, 1, 0, 1, 1, 1, 2], [D3, 2, 1, 1, 2, 4, 3]]);
  assert.deepEqual(r.days[2].topRefusals, [{ code: 'hands.full', n: 1 }, { code: 'no-room', n: 1 }, { code: 'walk.stuck', n: 1 }]);
  assert.deepEqual(r.days[2].clients, { 'eden/1.1': 1, none: 1 });
  assert.deepEqual(r.days[0].skipped, [{ world: 'gone', reason: 'missing' }]);
  assert.deepEqual(r.accounts, [{ account: 'u1', firstSeen: D1, lastSeen: D3, daysActive: 3 }, { account: 'u2', firstSeen: D3, lastSeen: D3, daysActive: 1 }]);
  const t = usageReport(usageFile, { days: 3, exclude: ['b'] });
  assert.deepEqual([t.days[2].accounts, t.days[2].souls, t.days[2].acts, t.days[2].refusals], [1, 1, 1, 1]);
  assert.deepEqual(t.accounts.find((a) => a.account === 'u1'), { account: 'u1', firstSeen: D1, lastSeen: D2, daysActive: 2 });
  assert.deepEqual(usageReport(usageFile, { days: 1 }).days.map((d) => d.day), [D3]);
  const text = formatReport(r);
  assert.match(text, /2026-11-03 {2}accounts 2 \(new 1, returning 1\) {2}Souls 2 {2}acts 4 {2}refusals 3 \(hands\.full 1, no-room 1, walk\.stuck 1\)/);
  assert.match(text, /Souls by client: eden\/1\.1 1, none 1/);
  assert.match(text, /u1 +2026-11-01 {2}2026-11-03 {2}3/);
  // op.mjs usage: GET /__sim/usage?days=N on the launcher's port, printed as text
  let asked;
  const srv = createServer((req, res) => { asked = req.url; res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r)); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const out = await new Promise((ok, no) => execFile(process.execPath, [fileURLToPath(new URL('./op.mjs', import.meta.url)), 'usage', '--port', String(srv.address().port), '--days', '3'], { encoding: 'utf8' }, (e, so) => (e ? no(e) : ok(so))));
    assert.equal(asked, '/__sim/usage?days=3');
    assert.equal(out.trim(), text);
  } finally { srv.close(); }
});
