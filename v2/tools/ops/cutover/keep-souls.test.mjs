// 0.133 W5: real people's Souls survive the move, on a fake host: a stage made by today's own server code (X11's
// fixture: three people's Souls in two old worlds, one of them "Gene"), given memories and relationships, then listed,
// confirmed, saved and copied into a new-system account store with X11's import-accounts.
//   node --test v2/tools/ops/cutover/keep-souls.test.mjs      (from the repository root; needs pnpm install and cargo)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classify, main, readSave } from './keep-souls.mjs';

const ROOT = resolve(import.meta.dirname, '../../../..');
const V2 = join(ROOT, 'v2');
const DIR = join(ROOT, '.local/keep-souls/test');
const DATA = join(DIR, 'fixture/data'), OUT = join(DIR, 'kept'), ETC = join(DIR, 'etc'), STORE = join(DIR, 'live/accounts.sqlite');
const IMPORT = join(V2, 'target/debug/import-accounts');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tree = (d) => readdirSync(d, { recursive: true }).map(String).sort().filter((f) => statSync(join(d, f)).isFile()).map((f) => [f, sha(readFileSync(join(d, f)))]);
const run = (...args) => { const lines = []; const code = main([...args, '--data', DATA, '--out', OUT, '--etc', ETC], (l) => lines.push(l)); return { code, text: lines.join('\n') }; };

let fx, before;
test('setup: a fake host with three people\'s Souls, memories and relationships', async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(ETC, { recursive: true });
  const { makeFixture } = await import('../../import-accounts/test/fixture.ts');
  fx = await makeFixture(join(DIR, 'fixture'));
  // "Gene" is alice: the launcher's settings name her stage account a site owner. bob and carol are real people.
  writeFileSync(join(ETC, 'data.conf'), `SIM_SITE_OWNERS=${fx.stage.alice}\n`);
  const hamlet = new DatabaseSync(join(DATA, 'worlds/x11-hamlet/sim.db'));
  const [oriel, , wren] = fx.worlds['x11-hamlet'].live.map((s) => s.id);
  hamlet.exec(`CREATE TABLE edge_timeline_v1(world_id TEXT NOT NULL, receipt_id TEXT NOT NULL, soul_id TEXT NOT NULL, kind TEXT NOT NULL, tick INTEGER NOT NULL, at INTEGER NOT NULL, world_day INTEGER, time TEXT, place_id TEXT, title TEXT, world TEXT, object_id TEXT, PRIMARY KEY(world_id, receipt_id));
    CREATE TABLE edge_comms_turns (world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, soul_id TEXT NOT NULL, tick INTEGER NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (world_id, conversation_id, seq));
    CREATE TABLE edge_follows_v1 (world_id TEXT NOT NULL, receipt_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (world_id, receipt_id));
    CREATE TABLE edge_comms_subscriptions (world_id TEXT NOT NULL, soul_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, cursor INTEGER NOT NULL, created_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (world_id, soul_id));`);
  hamlet.prepare('INSERT INTO edge_timeline_v1 VALUES (?, ?, ?, ?, 10, 1, 1, ?, ?, ?, ?, NULL)').run('x11-hamlet', 'r_1', wren, 'sang', '18:00', 'square', 'Sang at dusk', 'x11-hamlet');
  hamlet.prepare('INSERT INTO edge_comms_turns VALUES (?, ?, ?, ?, 11, 2, ?)').run('x11-hamlet', 'c_1', 1, oriel, 'Lovely song.');
  hamlet.prepare('INSERT INTO edge_comms_turns VALUES (?, ?, ?, ?, 12, 3, ?)').run('x11-hamlet', 'c_1', 2, wren, 'Thank you, Oriel.');
  hamlet.prepare('INSERT INTO edge_follows_v1 VALUES (?, ?, ?)').run('x11-hamlet', 'r_2', JSON.stringify({ follower: wren, followed: oriel }));
  hamlet.prepare('INSERT INTO edge_comms_subscriptions VALUES (?, ?, ?, ?, 0, 0, 0)').run('x11-hamlet', wren, 'https://hook.test/bearer-url-not-to-copy', 'webhook-secret-not-to-copy');
  // Sign-in, pairing and replay records that name the Soul: none of it is saved.
  hamlet.exec(`CREATE TABLE account_approvals_v1 (id TEXT PRIMARY KEY, world_id TEXT, soul_id TEXT, request_nonce TEXT, poll_hash TEXT);
    CREATE TABLE edge_idempotency_v1 (world_id TEXT NOT NULL, soul_id TEXT NOT NULL, route TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE edge_receipts_v1 (world_id TEXT NOT NULL, receipt_id TEXT NOT NULL, soul_id TEXT NOT NULL, capability TEXT NOT NULL, phase TEXT NOT NULL, accepted_tick INTEGER NOT NULL, client_ref TEXT, device_id TEXT, created_at INTEGER NOT NULL);`);
  hamlet.prepare('INSERT INTO account_approvals_v1 VALUES (?, ?, ?, ?, ?)').run('ap_1', 'x11-hamlet', wren, 'nonce-not-to-copy', 'poll-not-to-copy');
  hamlet.prepare('INSERT INTO edge_idempotency_v1 VALUES (?, ?, ?, ?, ?, 200, ?, 0)').run('x11-hamlet', wren, '/v1/edge/act', 'idem-key-not-to-copy', 'idem-hash-not-to-copy', 'idem-body-not-to-copy');
  hamlet.prepare('INSERT INTO edge_receipts_v1 VALUES (?, ?, ?, ?, ?, 10, ?, ?, 1)').run('x11-hamlet', 'r_1', wren, 'sing', 'done', 'client-ref-not-to-copy', 'device-not-to-copy');
  hamlet.prepare('UPDATE souls SET token_hash = ? WHERE id = ?').run('token-hash-not-to-copy', wren);
  hamlet.close();
  // The new system's account store as the directory keeps it (W1's schema, made by import-accounts from an empty set),
  // where bob has already signed in since the switch under a new account.
  execFileSync('cargo', ['build', '-q', '-p', 'import-accounts'], { cwd: V2, stdio: 'inherit' });
  mkdirSync(join(DIR, 'empty'), { recursive: true });
  assert.equal(spawnSync(IMPORT, [join(DIR, 'empty'), '--out', join(DIR, 'live'), '--json']).status, 0);
  const live = new DatabaseSync(STORE);
  live.prepare('INSERT INTO provider_accounts_v1 VALUES (?, ?, ?, ?)').run('acct_live_bob', 'https://clerk.fixture.test', 'user_bob', 1);
  live.close();
  before = tree(DATA);
});

test('1: list names every live Soul by world, name and owner, and Gene\'s candidate accounts with why', () => {
  const { code, text } = run('list');
  assert.equal(code, 0);
  assert.match(text, /NOT CONFIRMED/);
  assert.match(text, new RegExp(`${fx.stage.alice}.*user_alice.*a site owner`));
  assert.match(text, new RegExp(`${fx.forks.alice}.*the same sign-in as ${fx.stage.alice}`));
  for (const [slug, w] of Object.entries(fx.worlds)) for (const s of w.live) assert.match(text, new RegExp(`${s.name}  ${s.id}  owner ${s.owner}`), `${slug} ${s.name}`);
  assert.doesNotMatch(text, new RegExp(fx.worlds['x11-hamlet'].retired[0]));
  assert.equal(run('save').code, 1, 'save refuses until Gene confirms');
  const w = run('confirm', '--drop', 'acct_not_a_candidate', '--add', 'acct_nobody');
  assert.match(w.text, /candidates for Gene's accounts:\n.*user_alice/, 'the candidates are printed before anything is written');
  assert.match(w.text, /warning: --drop acct_not_a_candidate is not a candidate/);
  assert.match(w.text, /warning: --add acct_nobody is no account/);
  // The confirmation holds only for what was shown: another data folder, or a changed candidate list, is refused.
  mkdirSync(join(DIR, 'other'), { recursive: true });
  assert.match(run('save', '--data', join(DIR, 'other')).text, /refused: confirmed for the data folders/);
  writeFileSync(join(ETC, 'data.conf'), `SIM_SITE_OWNERS=${fx.stage.alice},${fx.stage.dana}\n`);
  assert.match(run('save').text, /refused: the candidates for Gene's accounts changed/);
  writeFileSync(join(ETC, 'data.conf'), `SIM_SITE_OWNERS=${fx.stage.alice}\n`);
  const c = run('confirm');
  assert.equal(c.code, 0);
  assert.match(c.text, /2 real people's Souls/);
  const after = run('list').text;
  assert.match(after, /real +Wren/); assert.match(after, /real +Ivo/);
  assert.match(after, /Gene +Oriel/); assert.match(after, /Gene +Bram/);
});

let tar;
test('2: one private, checksummed save of each real person\'s Soul: identity, body, memories, relationships', () => {
  const { code, text } = run('save');
  assert.equal(code, 0, text);
  tar = /to (\S+\.tar) /.exec(text)[1];
  assert.equal(statSync(tar).mode & 0o777, 0o600);
  assert.equal(statSync(OUT).mode & 0o777, 0o700);
  const { manifest, files } = readSave(tar);
  assert.deepEqual(manifest.counts, { souls: 2, people: 2, worlds: 2 });
  const wren = files['souls/x11-hamlet/' + fx.worlds['x11-hamlet'].live[2].id + '.json'];
  assert.equal(wren.identity.soul.name, 'Wren');
  assert.equal(wren.identity.owner.signIn, 'https://clerk.fixture.test user_bob');
  assert.equal(wren.body.snapshot.body.type, 'creature', 'the creature body it wears');
  assert.equal(wren.memories.edge_timeline_v1[0].title, 'Sang at dusk');
  assert.ok(wren.memories.events.length > 0, 'its own events');
  assert.deepEqual(wren.relationships.edge_comms_turns.map((t) => t.text), ['Lovely song.', 'Thank you, Oriel.']);
  assert.deepEqual(wren.relationships.people.map((p) => [p.name, p.turns, p.follows]), [['Oriel', 1, 1]]);
  const all = readFileSync(tar, 'utf8');
  assert.doesNotMatch(all, /not-to-copy|hook\.test/, 'no token, secret, webhook URL, nonce, idempotency key, client ref or device id');
  assert.equal(wren.memories.edge_receipts_v1[0].capability, 'sing', 'the receipt itself is kept');
  assert.ok(!Object.keys(files).some((f) => /Oriel|Bram/.test(JSON.stringify(files[f].identity?.soul?.name ?? ''))), 'no Soul of Gene\'s');
  // A changed byte is refused.
  const bad = join(DIR, 'bad.tar');
  writeFileSync(bad, readFileSync(tar)); writeFileSync(`${bad}.sha256`, readFileSync(`${tar}.sha256`));
  const b = readFileSync(bad); b[600] ^= 1; writeFileSync(bad, b);
  assert.throws(() => readSave(bad), /SHA-256/);
});

const imported = (account) => { const db = new DatabaseSync(STORE, { readOnly: true }); try {
  // directoryd's own reads (accounts/store.rs): My Souls' unpaired imported Souls, and pairing again by the former id.
  return db.prepare('SELECT i.soul, i.world, s.name, s.description FROM imported_souls_v1 i JOIN souls_v1 s ON s.soul = i.soul WHERE s.account_id = ? ORDER BY i.soul').all(account).map((r) => ({ ...r }));
} finally { db.close(); } };
const former = (world, old) => { const db = new DatabaseSync(STORE, { readOnly: true }); try {
  return { ...db.prepare('SELECT i.soul, s.account_id FROM imported_souls_v1 i JOIN souls_v1 s ON s.soul = i.soul WHERE i.world = ? AND i.old_soul = ?').get(world, old) };
} finally { db.close(); } };

test('3 and 4: each copied into the new system unpaired, under its owner\'s account there; then the plain list', () => {
  // A store held by a running directory, or a save that does not match its checksums, is refused and nothing changes.
  const held = new DatabaseSync(STORE);
  held.exec('BEGIN IMMEDIATE');
  const busy = run('copy', '--saved', tar, '--store', STORE, '--import-accounts', IMPORT);
  held.exec('ROLLBACK'); held.close();
  assert.equal(busy.code, 1); assert.match(busy.text, /refused, nothing copied/);
  assert.equal(run('copy', '--saved', join(DIR, 'bad.tar'), '--store', STORE, '--import-accounts', IMPORT).code, 1);
  assert.deepEqual(imported('acct_live_bob'), []);
  const { code, text } = run('copy', '--saved', tar, '--store', STORE, '--import-accounts', IMPORT);
  assert.equal(code, 0, text);
  assert.match(text, /2 Souls copied/);
  const wren = fx.worlds['x11-hamlet'].live[2], ivo = fx.worlds['x11-garden'].live[0];
  // bob signed in since the switch: his Soul joins that account. carol has not: her old account comes with it.
  assert.deepEqual(imported('acct_live_bob').map((r) => [r.world, r.name]), [['x11-hamlet', 'Wren']]);
  assert.deepEqual(imported(fx.forks.carol).map((r) => [r.world, r.name]), [['x11-garden', 'Ivo']]);
  assert.equal(former('x11-hamlet', wren.id).account_id, 'acct_live_bob');
  assert.equal(former('x11-garden', ivo.id).account_id, fx.forks.carol);
  const db = new DatabaseSync(STORE, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM imported_souls_v1').get().n, 2, 'none of Gene\'s');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM account_grants_v1 WHERE account_id = 'acct_live_bob' AND grant_text LIKE 'soul-%'").get().n, 1, 'its own grant, the page follows it');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM provider_accounts_v1 WHERE subject = 'user_bob'").get().n, 1, 'no second account for bob');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM provider_accounts_v1 WHERE subject = 'user_alice'").get().n, 0);
  } finally { db.close(); }
  // The plain list, per person.
  assert.match(text, /user_bob\n {2}- Wren in x11-hamlet \(old id s_\w+\): copied, unpaired: they sign in at soul\.game and pair it again/);
  assert.match(text, /user_carol\n {2}- Ivo in x11-garden \(old id s_\w+\): copied, unpaired \(their account made from their old sign-in\)/);
  assert.ok(readdirSync(OUT).some((f) => /^reconcile-.*\.txt$/.test(f)));
  // A second run changes nothing.
  const rows = () => { const d = new DatabaseSync(STORE, { readOnly: true }); try { return ['provider_accounts_v1', 'souls_v1', 'imported_souls_v1', 'account_grants_v1'].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => JSON.stringify(r))); } finally { d.close(); } };
  const once = rows();
  const again = run('copy', '--store', STORE, '--import-accounts', IMPORT); // the newest save, as the host paste runs it
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /0 Souls copied .* 2 already there/);
  // One staging folder per save, read back on the rerun (the same new ids), private.
  const staged = readdirSync(OUT).filter((f) => f.startsWith('new-'));
  assert.equal(staged.length, 1);
  for (const f of ['', ...readdirSync(join(OUT, staged[0]), { recursive: true }).map(String)]) { const s = statSync(join(OUT, staged[0], f)); assert.equal(s.mode & 0o777, s.isDirectory() ? 0o700 : 0o600, f); }
  // A missing import program is refused, not a crash.
  const none = run('copy', '--store', STORE, '--import-accounts', join(DIR, 'no-such-program'));
  assert.equal(none.code, 1); assert.match(none.text, /refused, nothing copied: no import-accounts program/);
  assert.deepEqual(rows(), once);
});

test('a Soul on the operator\'s list of Gene\'s Souls is always his, whoever the confirmed accounts are', () => {
  const stages = { accounts: new Map([['acct_x', { issuer: 'i', subject: 'x' }]]), site: [],
    worlds: [{ slug: 'w', file: 'f', souls: [{ id: 's_1', world_id: 'w', owner: 'acct_x', name: 'Kwyjibo', denied: true }, { id: 's_2', world_id: 'w', owner: 'acct_x', name: 'Other', denied: false }] }] };
  assert.deepEqual(classify(stages, new Set()).map((r) => [r.name, r.who]), [['Kwyjibo', 'Gene'], ['Other', 'real']]);
  assert.deepEqual(classify(stages, null).map((r) => r.who), ['Gene', '?']);
});

test('nothing in the old worlds was changed or deleted', () => {
  assert.deepEqual(tree(DATA), before);
});
