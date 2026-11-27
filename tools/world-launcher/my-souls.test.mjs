// node --test tools/world-launcher/my-souls.test.mjs (#2466; launcher and fake worlds on a free block of ports)
// The homepage's My Souls read: the signed-in account's own Souls across worlds and nobody else's; nothing signed out;
// no owner id, token or token hash in the answer; the photo route serves only a live Soul's stored picture by its hash.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLauncher } from './launcher.mjs';
import { ownedSouls } from './my-souls.mjs';
import { testPort } from '../lib/test-port.ts';
const P0 = await testPort(5);

const PORT = P0 + 4, RANGE = [P0, P0 + 3];
const dir = mkdtempSync(join(tmpdir(), 'launcher-my-souls-'));
const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
const webDir = join(dir, 'web'); mkdirSync(webDir);
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } });
let L;
after(async () => { await L?.close(); });

const png = Buffer.from('fake portrait bytes'), pngHash = createHash('sha256').update(png).digest('hex');
/** A world store with the tables the read uses (shapes from apps/server/src/migrations.ts and accounts/store.ts). */
function store(file, worldId, souls, members = [], legacy = []) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE souls (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, owner TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, token_hash TEXT, token_created_at INTEGER, native INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE account_soul_memberships_v1 (world_id TEXT NOT NULL, soul_id TEXT NOT NULL, account_id TEXT NOT NULL, attribution TEXT NOT NULL, evidence_hash TEXT NOT NULL, created_at INTEGER NOT NULL, current_grant_id TEXT, PRIMARY KEY(world_id,soul_id));
    CREATE TABLE account_legacy_authority_v1 (world_id TEXT NOT NULL,soul_id TEXT NOT NULL,legacy_owner_id TEXT NOT NULL, captured_at INTEGER NOT NULL,revoked_at INTEGER,revoked_reason TEXT, PRIMARY KEY(world_id,soul_id));
    CREATE TABLE events (world_id TEXT NOT NULL, seq INTEGER NOT NULL, tick INTEGER NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, soul_id TEXT, PRIMARY KEY (world_id, seq));
    CREATE TABLE soul_auto_portraits_v1(world_id TEXT NOT NULL,soul_id TEXT NOT NULL,look_key TEXT NOT NULL,hash TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,image BLOB NOT NULL,PRIMARY KEY(world_id,soul_id)) WITHOUT ROWID;`);
  for (const s of souls) db.prepare('INSERT INTO souls (id, world_id, owner, entity_id, name, description, created_at, retired_at, token_hash) VALUES (?,?,?,?,?,?,?,?,?)').run(s.id, worldId, s.owner, `e_${s.id}`, s.name, s.description ?? '', s.at ?? 1000, s.retired ?? null, s.token ?? 'secret-token-hash');
  for (const [soul, account] of members) db.prepare('INSERT INTO account_soul_memberships_v1 VALUES (?,?,?,?,?,?,NULL)').run(worldId, soul, account, 'approval', 'h', 1);
  for (const [soul, account] of legacy) db.prepare('INSERT INTO account_legacy_authority_v1 VALUES (?,?,?,1,NULL,NULL)').run(worldId, soul, account);
  db.prepare('INSERT INTO soul_auto_portraits_v1 VALUES (?,?,?,?,1,1,?)').run(worldId, 's_alice1', 'k', pngHash, png);
  // two body assignments for s_alice1: the later one is its body
  const event = db.prepare("INSERT INTO events VALUES (?,?,0,'body-assignment-v1','x',?,0,'s_alice1')");
  event.run(worldId, 1, JSON.stringify({ body: { family: 'humanoid', model: 'humanoid2-0000000000000001', params: { hair: 'old' } } }));
  event.run(worldId, 2, JSON.stringify({ body: { family: 'humanoid', model: 'humanoid2-0000000000000002', params: { hair: 'new' } } }));
  db.close();
}

test('ownership is the world rule: a membership decides; a dev owner needs its membership or legacy authority', () => {
  const file = join(dir, 'unit.db');
  store(file, 'w-1', [
    { id: 's_alice1', owner: 'acct_alice', name: 'Ada' },
    { id: 's_moved', owner: 'acct_alice', name: 'Moved' },            // owner column says alice, membership says bob
    { id: 's_member', owner: 'acct_other', name: 'Member' },          // membership makes it alice's
    { id: 's_gone', owner: 'acct_alice', name: 'Gone', retired: 5 },  // retired: not listed
    { id: 's_dev', owner: 'dev:alice', name: 'Dev no proof' },        // dev owner without membership or authority
    { id: 's_devok', owner: 'dev:alice', name: 'Dev legacy' },
  ], [['s_moved', 'acct_bob'], ['s_member', 'acct_alice']], [['s_devok', 'dev:alice']]);
  assert.deepEqual(ownedSouls(file, 'w-1', 'acct_alice').map((s) => s.id), ['s_alice1', 's_member']);
  assert.deepEqual(ownedSouls(file, 'w-1', 'acct_bob').map((s) => s.id), ['s_moved']);
  assert.deepEqual(ownedSouls(file, 'w-1', 'dev:alice').map((s) => s.id), ['s_devok']);
  assert.deepEqual(ownedSouls(file, 'w-other', 'acct_alice'), [], 'another world id in the same file is not this world');
  assert.deepEqual(ownedSouls(join(dir, 'missing.db'), 'w-1', 'acct_alice'), []);
  // a world without accounts (no account tables) goes by the owner column, as its own Souls.owns does
  const plain = join(dir, 'plain.db'), db = new DatabaseSync(plain);
  db.exec('CREATE TABLE souls (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, owner TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, token_hash TEXT)');
  db.prepare("INSERT INTO souls VALUES ('s_a','w-1','dev:alice','e1','A','',1,NULL,NULL), ('s_b','w-1','dev:bob','e2','B','',2,NULL,NULL)").run(); db.close();
  assert.deepEqual(ownedSouls(plain, 'w-1', 'dev:alice').map((s) => s.id), ['s_a']);
});

test('GET /__sim/my-souls.json: the account\'s own Souls across worlds, never another account\'s, nothing signed out', async () => {
  L = await openLauncher({ port: PORT, range: RANGE, dataDir: join(dir, 'data'), webDir, templatesDir, command, eager: 0, log: () => {} });
  const base = `http://127.0.0.1:${PORT}`;
  const slugs = [];
  for (const name of ['North Field', 'South Field']) {
    const r = await fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal(r.status, 201); slugs.push((await r.json()).slug);
  }
  const [north, south] = slugs;
  store(join(dir, 'data', 'worlds', north, 'sim.db'), `${north}-1`, [
    { id: 's_alice1', owner: 'dev:alice', name: 'Ada', description: 'Keeps bees', at: 2000 },
    { id: 's_bob1', owner: 'dev:bob', name: 'Bo', at: 1000 },
  ], [['s_alice1', 'dev:alice'], ['s_bob1', 'dev:bob']]);
  store(join(dir, 'data', 'worlds', south, 'sim.db'), `${south}-1`, [
    { id: 's_alice2', owner: 'dev:alice', name: 'Ines', at: 3000 },
    { id: 's_alice1', owner: 'dev:alice', name: 'Ada', at: 2500 },   // the same Soul, living here too
    { id: 's_bob2', owner: 'dev:bob', name: 'Cy' },
  ], [['s_alice2', 'dev:alice'], ['s_alice1', 'dev:alice'], ['s_bob2', 'dev:bob']]);

  const read = (who) => fetch(`${base}/__sim/my-souls.json`, who ? { headers: { authorization: `Bearer ${who}` } } : {});
  for (const r of [await read(null), await read('god_notasession'), await read('nonsense')]) {
    assert.equal(r.status, 401); const body = await r.json(); assert.equal(body.souls, undefined);
  }
  const r = await read('dev:alice');
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const text = await r.text(), mine = JSON.parse(text);
  assert.equal(mine.contract, 'my-souls/1');
  assert.deepEqual(mine.souls.map((s) => s.id), ['s_alice1', 's_alice2'], 'only alice\'s Souls, oldest first');
  const ada = mine.souls[0];
  assert.deepEqual(Object.keys(ada).sort(), ['body', 'bornAt', 'description', 'id', 'name', 'photoUrl', 'worlds']);
  assert.deepEqual(ada.body, { family: 'humanoid', model: 'humanoid2-0000000000000002', params: { hair: 'new' } }, 'the latest body assignment');
  assert.equal(mine.souls[1].body, null, 'no humanoid look: the modal shows the picture');
  assert.equal(ada.name, 'Ada'); assert.equal(ada.description, 'Keeps bees'); assert.equal(ada.bornAt, 2000);
  assert.deepEqual(ada.worlds.map((w) => [w.slug, w.name, w.url]), [[north, 'North Field', `/w/${north}/?dev=1`], [south, 'South Field', `/w/${south}/?dev=1`]]);
  assert.equal(mine.souls[1].photoUrl, null, 'no stored picture: the card draws initials');
  for (const leak of ['s_bob', 'dev:bob', 'dev:alice', 'secret-token-hash', 'owner', 'token']) assert.ok(!text.includes(leak), `no ${leak} in the answer`);
  const bob = await (await read('dev:bob')).json();
  assert.deepEqual(bob.souls.map((s) => s.id).sort(), ['s_bob1', 's_bob2']);

  // the picture: served by its content address for a live Soul, without its world's process
  const pic = await fetch(base + ada.photoUrl);
  assert.equal(pic.status, 200); assert.equal(pic.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await pic.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/__sim/soul-photo/${north}/s_bob1/${pngHash}.png`)).status, 404, 'another Soul\'s address: not found');
  assert.equal((await fetch(`${base}/__sim/soul-photo/${north}/s_alice1/${'0'.repeat(64)}.png`)).status, 404);
});
