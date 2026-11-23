// node --test tools/world-launcher/my-souls-moved.test.mjs (MS, 0.132.1; launcher, fake worlds and a fake directory)
// My Souls on a moved world: the launcher lists the signed-in person's Souls of a world bound to the new engine from the
// directory's own list (asked with that person's own sign-in), not from the world's old store; an old-engine world is
// read as before; another person's Souls, a Soul's device and the account never appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLauncher } from './launcher.mjs';
import { directorySouls, v2SoulId } from './my-souls.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

/** A world store with one dev-owned Soul (the table shape the read uses; my-souls.test.mjs has the full one). */
function store(file, worldId, id, owner, name) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE souls (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, owner TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, token_hash TEXT)');
  db.prepare("INSERT INTO souls VALUES (?,?,?,?,?,'',1000,NULL,'h')").run(id, worldId, owner, `e_${id}`, name); db.close();
}

test('v2SoulId is the moved page\'s own Soul id; directorySouls keeps only moved worlds\' Souls and public fields', () => {
  assert.equal(v2SoulId('soul-53db9cb75a8e6efed9b117fcac835ee3-0'), 's_53db9cb75a8e6efed9b117fcac835ee3-0');
  const eden = { slug: 'eden', name: 'Eden' };
  const got = directorySouls([
    { soul: 'soul-aa-1', device: 'laptop', world: 'eden', name: 'Ada', description: 'Keeps bees', picture: 'data:image/png;base64,AAAA', retire_asked: false },
    { soul: 'soul-aa-2', world: 'elsewhere', name: 'Far' },              // a world this launcher has not moved
    { soul: 'soul-aa-3', world: null, name: 'Nowhere' },                  // no world named
    { soul: 'creator-aa-1', world: 'eden', name: 'Creator' },              // not a Soul
    { soul: 'soul-aa-4', world: 'eden', name: null, picture: 'javascript:alert(1)' },
  ], new Map([['eden', eden]]), (w) => `/w/${w.slug}/`);
  assert.deepEqual(got, [
    { id: 's_aa-1', name: 'Ada', description: 'Keeps bees', bornAt: null, photoUrl: 'data:image/png;base64,AAAA', body: null, worlds: [{ slug: 'eden', name: 'Eden', url: '/w/eden/' }] },
    { id: 's_aa-4', name: 'Unnamed Soul', description: '', bornAt: null, photoUrl: null, body: null, worlds: [{ slug: 'eden', name: 'Eden', url: '/w/eden/' }] },
  ]);
  assert.deepEqual(directorySouls(null, new Map(), String), []);
});

test('GET /__sim/my-souls.json: a moved world\'s Souls come from the directory, an old world\'s from its store', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-my-souls-moved-'));
  const templatesDir = join(dir, 'templates'), webDir = join(dir, 'web'); mkdirSync(templatesDir); mkdirSync(webDir);
  // the directory: each test person's own Souls (route.rs `/v1/account/souls`), and what it was asked
  const asked = [];
  const souls = {
    alice: [{ soul: 'soul-5d0b-0', device: 'alice-laptop', world: 'eden', name: 'Oriel', description: 'Walks the shore', picture: null, retire_asked: false },
      { soul: 'soul-5d0b-1', device: null, world: 'mars', name: 'Elsewhere', description: '', picture: null, retire_asked: false }],
    bob: [{ soul: 'soul-77aa-0', device: 'bob-box', world: 'eden', name: 'Bram', description: '', picture: null, retire_asked: false }],
  };
  let up = true;
  const directory = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asked.push({ path: req.url, authorization: req.headers.authorization ?? null, body: JSON.parse(body || '{}') });
      const list = req.url === '/v1/account/souls' && up ? souls[JSON.parse(body || '{}').test_person] : undefined;
      res.writeHead(list ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(list ? { souls: list } : { refused: 'signed-out' }));
    });
  });
  await new Promise((ok) => directory.listen(0, '127.0.0.1', ok));
  const P = await testPort(5), base = `http://127.0.0.1:${P + 4}`, fake = new URL('./fake-world.mjs', import.meta.url).pathname;
  const binding = join(dir, 'binding.json'), routesFile = join(dir, 'routes.json');
  const L = await openLauncher({ port: P + 4, range: [P, P + 3], dataDir: join(dir, 'data'), webDir, templatesDir, eager: 0, log: () => {}, cutoverBindingFile: binding,
    v2DirectoryUrl: `http://127.0.0.1:${directory.address().port}`, command: (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } }) });
  t.after(async () => { await L.close(); directory.close(); rmSync(dir, { recursive: true, force: true }); });

  const made = [];
  for (const name of ['Eden', 'Old Field']) {
    const r = await fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal(r.status, 201); made.push((await r.json()).slug);
  }
  const [eden, old] = made;
  store(join(dir, 'data', 'worlds', eden, 'sim.db'), `${eden}-1`, 's_oldeden', 'dev:alice', 'Old Eden Soul');
  store(join(dir, 'data', 'worlds', old, 'sim.db'), `${old}-1`, 's_field', 'dev:alice', 'Field');
  const route = (canonical) => writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { canonical, stream: '/s/eden/' } } }));
  const settle = () => new Promise((r) => setTimeout(r, 1100));   // the launcher looks at the binding file once a second
  const read = async (who) => (await fetch(`${base}/__sim/my-souls.json`, { headers: { authorization: `Bearer ${who}` } })).json();
  const ids = (a) => a.souls.map((s) => s.id);

  // bound but the switch off: Eden is an old-engine world still, read from its store, and the directory is not asked
  route(false); writeFileSync(binding, JSON.stringify({ oldWorldId: `${eden}-1`, canonicalSlug: 'eden', routesFile, clientDir: dir })); await settle();
  assert.deepEqual(ids(await read('dev:alice')), ['s_oldeden', 's_field']);
  assert.equal(asked.length, 0);

  // moved: Eden's Souls are the directory's, asked as alice's own test sign-in; Mars is not moved here, so not listed
  route(true); await settle();
  const text = await (await fetch(`${base}/__sim/my-souls.json`, { headers: { authorization: 'Bearer dev:alice' } })).text(), mine = JSON.parse(text);
  assert.equal(mine.contract, 'my-souls/1');
  assert.deepEqual(ids(mine), ['s_field', 's_5d0b-0'], 'the old world\'s Soul from its store, Eden\'s from the directory, not its old store');
  const oriel = mine.souls[1];
  assert.deepEqual(Object.keys(oriel).sort(), ['body', 'bornAt', 'description', 'id', 'name', 'photoUrl', 'worlds'], 'the fields the home page reads');
  assert.equal(oriel.name, 'Oriel'); assert.equal(oriel.description, 'Walks the shore');
  assert.deepEqual(oriel.worlds, [{ slug: eden, name: 'Eden', url: `/w/${eden}/?dev=1` }], 'its world\'s page, where ?follow=1#soul/<id> follows it');
  assert.deepEqual(asked.at(-1), { path: '/v1/account/souls', authorization: null, body: { test_person: 'alice' } });
  for (const leak of ['alice-laptop', 'device', 'soul-5d0b', 'Bram', 'bob', 'dev:alice', 'account']) assert.ok(!text.includes(leak), `no ${leak} in the answer`);
  assert.deepEqual(ids(await read('dev:bob')), ['s_77aa-0'], 'bob sees his own and no one else\'s');

  // the directory down: the moved world's Souls are not listed; every other world's still are
  up = false;
  assert.deepEqual(ids(await read('dev:alice')), ['s_field']);
});
