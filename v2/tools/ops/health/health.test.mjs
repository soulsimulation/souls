// Engine v2 O21 (#3325): the site owner's health page, the daily usage table and the history of measures. Each
// `aN` test is one acceptance box. A2 runs the real supervisor (`cargo build -p supervisor`; $SUPERVISOR overrides).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryVerifier, serve } from './page.mjs';
import { collector, report as historyReport, text as historyText, bytes, DEFAULTS } from './history.mjs';
import { rollupDay, report as usageReport } from './usage.mjs';
import { readWorlds } from './read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const V2 = join(HERE, '..', '..', '..');
const W1 = `${'a1'.repeat(16)}-${'b2'.repeat(16)}-0`;
const W2 = `${'c3'.repeat(16)}-${'d4'.repeat(16)}-1`;
const SLEEPER = `${'e5'.repeat(16)}-${'f6'.repeat(16)}-2`;
const SOUL = `${'99'.repeat(16)}:7`, WORDS = 'meet me by the old fountain at dusk';
const TOKENS = { 'owner-token': 'acct-owner', 'other-token': 'acct-other' };

/** CBOR for the directory record's fields the page reads (major types 0, 3 and 5 only). */
function cborMap(entries) {
  const head = (major, n) => (n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n]
    : n < 65536 ? [major << 5 | 25, n >> 8, n & 255] : [major << 5 | 27, ...Buffer.from(BigInt(n).toString(16).padStart(16, '0'), 'hex')]);
  const out = head(5, entries.length);
  for (const [k, v] of entries) {
    out.push(...head(0, k));
    if (typeof v === 'string') out.push(...head(3, Buffer.byteLength(v)), ...Buffer.from(v)); else out.push(...head(0, v));
  }
  return Buffer.from(out);
}

function scratch() {
  const base = join(V2, '..', '.local');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'o21-'));
}

/** A machine's folder: W1 running with O4's health.json, W2 restarting, SLEEPER stopped with a wake time. */
function machine() {
  const root = scratch();
  const put = (p, text) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); };
  const sup = (w, state, count, failures, lastExit) => put(`health/${w}.json`, `${JSON.stringify({ world: w, at: Date.now(), state, count, failures, last_exit: lastExit, next_try: null })}\n`);
  sup(W1, 'running', 1, 0, null);
  sup(W2, 'restarting', 2, 1, 'exit-code (exited 1)');
  sup(SLEEPER, 'stopped', 0, 0, null);
  put(`worlds/${W1}/health.json`, JSON.stringify({
    at_unix_ms: Date.now() - 1000, written: 9, budget_us: 50000, ticks: { count: 90, mean_us: 900, p50_us: 800, p99_us: 4200, max_us: 6000 },
    over_budget: 0, inverted_stamps: 0, queues: { arrivals: { items: 0, oldest_us: 0 }, tick: { items: 2, oldest_us: 31000 } },
  }));
  // A Soul's words and id sit in the world's folder; none may reach the page.
  put(`worlds/${W1}/receipts/${new Date().toISOString().slice(0, 10)}.jsonl`, `${JSON.stringify({ t: Date.now(), soul: SOUL, outcome: 'receipt', said: WORDS })}\n`);
  put(`worlds/${W1}/world.log`, WORDS);
  put(`cache/${W1}`, cborMap([[3, 'souls:machine-1'], [4, 3]]));
  put(`cache/${SLEEPER}`, cborMap([[3, 'souls:machine-1'], [4, 1], [7, 1_900_000_000_000_000]]));
  mkdirSync(join(root, 'worlds', SLEEPER), { recursive: true });
  return root;
}

/** The directory's sign-in as W1 answers it, counting the requests made of it. */
async function directory() {
  const seen = [];
  const s = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const account = TOKENS[String(req.headers.authorization ?? '').replace('Bearer ', '')];
    res.writeHead(account ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(account ? { account, principal: 'p:0' } : { error: 'token.refused' }));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, seen, close: () => s.close() };
}

async function page(root, dir, extra = {}) {
  const s = serve({ root, owners: ['acct-owner'], verify: directoryVerifier(dir.url), ...extra });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}/ops/health`;
  const get = async (q = '', headers = {}) => { const r = await fetch(base + q, { headers }); return { status: r.status, text: await r.text() }; };
  return { get, close: () => s.close() };
}

/** Every file under `dir`: its size and modification time. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n), st = statSync(p); if (st.isDirectory()) walk(p); else out[p] = `${st.size} ${st.mtimeMs}`; } };
  walk(dir);
  return out;
}

test('a1: a site owner sees each world; another account and an anonymous request get no numbers', async () => {
  const root = machine(), dir = await directory(), p = await page(root, dir);
  try {
    const shell = await p.get();
    assert.equal(shell.status, 200);
    assert.match(shell.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.ok(!shell.text.includes(W1), 'the shell carries no data');
    const owner = await p.get('?json=1', { authorization: 'Bearer owner-token' });
    assert.equal(owner.status, 200);
    const d = JSON.parse(owner.text);
    assert.deepEqual(d.worlds.map((w) => w.world), [W1, W2, SLEEPER]);
    const [a, b, c] = d.worlds;
    assert.equal(a.state, 'running'); assert.equal(a.awake, 'awake'); assert.equal(a.where, 'souls:machine-1');
    assert.deepEqual([a.tick.lag_ms, a.tick.p99_ms, a.tick.budget_ms, a.tick.over_budget], [31, 4.2, 50, 0]);
    assert.equal(b.state, 'restarting'); assert.equal(b.restarts.failures, 1); assert.equal(b.restarts.last_exit, 'exit-code (exited 1)');
    assert.equal(c.awake, 'asleep'); assert.equal(c.wake_at, 1_900_000_000_000);
    assert.equal(a.watcher, null); assert.ok(d.not_metered.watcher && d.not_metered.cost);
    const cookie = await p.get('?json=1', { cookie: 'x=1; __session=owner-token' });
    assert.equal(cookie.status, 200);
    for (const [headers, status] of [[{ authorization: 'Bearer other-token' }, 403], [{}, 401], [{ authorization: 'Bearer forged' }, 401], [{ cookie: '__session=other-token' }, 403]]) {
      const r = await p.get('?json=1', headers);
      assert.equal(r.status, status);
      assert.ok(!r.text.includes(W1) && !/\d{3,}/.test(r.text), `no numbers for ${JSON.stringify(headers)}: ${r.text}`);
    }
  } finally { p.close(); dir.close(); }
});

test('a1: a cost column O11 fills when it is given', async () => {
  const root = machine(), dir = await directory(), p = await page(root, dir, { cost: (w) => (w === W1 ? '$0.41' : null) });
  try {
    const d = JSON.parse((await p.get('?json=1', { authorization: 'Bearer owner-token' })).text);
    assert.deepEqual(d.worlds.map((w) => w.cost), ['$0.41', null, null]);
  } finally { p.close(); dir.close(); }
});

test('a2: a planted restart loop under the real supervisor shows on the page as restart-loop', async () => {
  const sup = process.env.SUPERVISOR ?? [join(V2, 'target', 'debug', 'supervisor'), join(V2, 'target', 'release', 'supervisor')].find(existsSync);
  assert.ok(sup, 'build the supervisor first: cargo build -p supervisor (in v2/)');
  const root = scratch(), dir = await directory(), p = await page(root, dir);
  const env = { ...process.env, WORLDS_ROOT: root, SERVICE_RESULT: 'exit-code', EXIT_CODE: 'exited', EXIT_STATUS: '77' };
  for (const k of Object.keys(env)) if (k.startsWith('DIRECTORY_STORE')) delete env[k];
  const state = async () => JSON.parse((await p.get('?json=1', { authorization: 'Bearer owner-token' })).text).worlds.find((w) => w.world === W1);
  try {
    let shown = null;
    for (let i = 0; i < 5; i++) {
      // The unit's ExecStart with no pin in the directory fails at once (pin.missing); its ExecStopPost records the exit.
      try { execFileSync(sup, ['launch', W1], { env, stdio: 'pipe' }); } catch (e) { assert.equal(e.status, 77); }
      execFileSync(sup, ['exited', W1], { env, stdio: 'pipe' });
      shown = await state();
      if (i < 4) assert.equal(shown.state, 'restarting');
    }
    const planted = Date.now();
    shown = await state();
    assert.equal(shown.state, 'restart-loop');
    assert.equal(shown.restarts.in_5_min, 5);
    assert.match(shown.restarts.last_exit, /^pin\.missing/);
    // The page asks every 30 s and each answer reads the record afresh: the loop shows within one period.
    assert.match(readFileSync(join(V2, 'web', 'health.html'), 'utf8'), /setInterval\(load, 30_000\)/);
    console.log(`a2: restart-loop on the page ${Date.now() - planted} ms after the fifth failed start (page period 30 s)`);
  } finally { p.close(); dir.close(); }
});

test('a3: over a scripted day the roll-up equals the driver\'s receipts; an unreadable world is skipped, never zero', () => {
  const root = scratch(), day = '2026-11-17', t0 = Date.parse(`${day}T00:00:00Z`);
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const want = new Map();
  for (const world of [W1, W2]) {
    const dirR = join(root, 'worlds', world, 'receipts');
    mkdirSync(dirR, { recursive: true });
    const lines = [];
    for (let i = 0; i < 4000; i++) {
      const soul = `${world.slice(0, 4)}:${rand(12)}`, t = t0 + Math.floor((i * 86_400_000) / 4000), refused = rand(5) === 0;
      const client = `souls-client/0.${rand(3)}`;
      lines.push(JSON.stringify({ t, soul, account: `acct-${soul}`, outcome: refused ? 'refusal' : 'receipt', client }));
      const k = `${world} ${soul}`, w = want.get(k) ?? { acts: 0, refusals: 0, client: null };
      if (refused) w.refusals++; else w.acts++;
      w.client = client;
      want.set(k, w);
    }
    lines.push('{"t": 1, "soul": "torn'); // a torn last line
    writeFileSync(join(dirR, `${day}.jsonl`), lines.join('\n'));
  }
  mkdirSync(join(root, 'worlds', SLEEPER), { recursive: true }); // no receipts folder: cannot read
  const store = join(root, 'usage.sqlite');
  const first = rollupDay(store, root, day);
  assert.deepEqual(first.read, [W1, W2]);
  assert.deepEqual(first.skipped, [{ world: SLEEPER, reason: 'no-receipts' }]);
  rollupDay(store, root, day); // again: rows replaced, not added
  const r = usageReport(store, 7, Date.parse('2026-11-18T12:00:00Z'));
  assert.equal(r.souls.length, want.size);
  for (const s of r.souls) {
    const w = want.get(`${s.world} ${s.soul}`);
    assert.deepEqual([s.acts, s.refusals, s.last_client], [w.acts, w.refusals, w.client], `${s.world} ${s.soul}`);
  }
  assert.equal(r.souls.filter((s) => s.world === SLEEPER).length, 0, 'a skipped world has no rows, not zeros');
  assert.deepEqual(r.worlds.find((w) => w.world === SLEEPER), { day, world: SLEEPER, status: 'skipped', reason: 'no-receipts' });
  assert.ok(!JSON.stringify(r).includes('acct-'), 'the report leaves the account ids in the store');
  if (process.getuid?.() !== 0) {
    chmodSync(join(root, 'worlds', W2, 'receipts', `${day}.jsonl`), 0);
    const again = rollupDay(store, root, day);
    assert.deepEqual(again.skipped.map((s) => s.world), [W2, SLEEPER]);
    assert.equal(usageReport(store, 7, Date.parse('2026-11-18T12:00:00Z')).souls.filter((s) => s.world === W2).length, 0);
  }
});

test('a4: report --range 24h prints from the history, which stays under its declared bound over 90 simulated days', () => {
  const root = machine(), dir = join(scratch(), 'history');
  const rows = readWorlds(root, Date.now());
  const start = Date.parse('2026-08-20T00:00:00Z'), end = start + 90 * 86_400_000;
  // The defaults: every 30 s for 90 days, three worlds.
  const c = collector(dir);
  let most = 0;
  for (let t = start; t < end; t += 30_000) { const n = c.add(rows, t); if (n > most) most = n; }
  assert.equal(bytes(dir), c.bytes());
  assert.ok(most <= DEFAULTS.maxBytes, `${most} > ${DEFAULTS.maxBytes}`);
  const fine = readdirSync(join(dir, 'fine')).length, hourly = readdirSync(join(dir, 'hourly')).length;
  assert.ok(fine <= DEFAULTS.fineDays + 1 && hourly <= DEFAULTS.keepDays, `${fine} fine days, ${hourly} hourly`);
  console.log(`a4: 90 days, 3 worlds every 30 s: at most ${most} bytes (${(most / 3 / 2 ** 20).toFixed(2)} MiB a world; bound ${DEFAULTS.maxBytes})`);
  const r = historyReport(dir, '24h', end);
  assert.deepEqual(r.worlds.map((w) => [w.world, w.samples]), [[W1, 2880], [W2, 2880], [SLEEPER, 2880]]);
  assert.equal(r.worlds[2].awake, 0);
  const week = historyReport(dir, '7d', end);
  assert.equal(week.worlds[0].samples, 7 * 2880);
  const printed = execFileSync(process.execPath, [join(HERE, 'history.mjs'), 'report', '--dir', dir, '--range', '24h']).toString();
  assert.match(printed, /^history /);
  console.log(historyText(r));
  // A tight bound (above one day of fine samples, about 1.3 MB here) holds too: the oldest files go first.
  const small = join(scratch(), 'history'), c2 = collector(small, { maxBytes: 3_000_000 });
  for (let t = start; t < start + 10 * 86_400_000; t += 30_000) assert.ok(c2.add(rows, t) <= 3_000_000);
  assert.ok(bytes(small) <= 3_000_000);
});

test('a5: the page, the roll-up and the history wake no sleeping world; the page holds no Soul\'s words or token', async () => {
  const root = machine(), dir = await directory(), p = await page(root, dir);
  try {
    const before = snapshot(root);
    const body = (await p.get('?json=1', { authorization: 'Bearer owner-token' })).text;
    rollupDay(join(scratch(), 'usage.sqlite'), root, new Date().toISOString().slice(0, 10));
    const h = join(scratch(), 'history');
    collector(h).add(readWorlds(root, Date.now()), Date.now());
    historyReport(h, '24h');
    assert.deepEqual(snapshot(root), before, 'nothing under the worlds root was written');
    const sleeper = JSON.parse(body).worlds.find((w) => w.world === SLEEPER);
    assert.equal(sleeper.awake, 'asleep');
    assert.deepEqual(dir.seen, ['POST /v1/account/session'], 'the only request made is the sign-in, once (cached)');
    for (const f of ['read.mjs', 'page.mjs', 'usage.mjs', 'history.mjs']) {
      const src = readFileSync(join(HERE, f), 'utf8');
      assert.ok(!/from 'node:(child_process|net|dgram)'/.test(src), `${f} starts nothing and opens no socket to a world`);
    }
    for (const secret of [SOUL, WORDS, 'owner-token', 'acct-owner', 'said']) assert.ok(!body.includes(secret), `the page's JSON holds ${secret}`);
    const keys = new Set();
    const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) keys.add(k); walk(x); } };
    walk(JSON.parse(body));
    assert.deepEqual([...keys].sort(), ['at', 'awake', 'budget_ms', 'cost', 'failures', 'health_age_s', 'in_5_min', 'lag_ms', 'last_exit', 'next_try',
      'not_metered', 'over_budget', 'p99_ms', 'restarts', 'state', 'tick', 'wake_at', 'watcher', 'where', 'world', 'worlds']);
  } finally { p.close(); dir.close(); }
});

