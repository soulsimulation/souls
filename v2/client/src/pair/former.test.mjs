// A Soul of today's client paired again by its owner (Engine v2 R18, #2821): R18's `pairFormer` against the real
// directory (`directoryd` with the sign-in for test worlds), its account store holding X11's import of the Soul. The
// contract is the one `client/test/compat/frozen-world.mjs` stands in for: a request names the Soul's `former` id and
// its `world`; the owner's approval pairs the Soul X11 brought over for that former id, and only for its own account;
// the poll answers `{token, grant, former}`. Run from v2/ after `cargo build -p directoryd --locked`.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pairFormer } from '../upgrade/upgrade.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = process.env.DIRECTORYD ?? join(v2, 'target/debug/directoryd');
const dir = mkdtempSync(join(tmpdir(), 'souls-r18-dir-'));
const store = join(dir, 'accounts.sqlite'), tokens = join(dir, 'gateway-tokens.txt');
const procs = new Set();
after(() => { for (const p of procs) p.kill(); rmSync(dir, { recursive: true, force: true }); });

/** directoryd on its own store, as the switch-over runs it: its origin and a stop that waits for its exit. */
async function directoryd() {
  const p = spawn(bin, ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1', '--store', store, '--test-sign-in',
    '--pairing', join(dir, 'pairing.sqlite'), '--gateway-tokens', tokens], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(p);
  const origin = await new Promise((ok, fail) => {
    let out = '';
    const take = (d) => { out += d; const m = /listening on (\S+)\n/.exec(out); if (m) ok(`http://${m[1]}`); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('exit', (c) => fail(new Error(`directoryd ended (${c}): ${out}`)));
  });
  const stop = () => new Promise((ok) => { p.removeAllListeners('exit'); p.on('exit', ok); p.kill(); procs.delete(p); });
  return { origin, stop };
}

const post = async (origin, path, body) => {
  const r = await fetch(new URL(path, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('R18: the real directory pairs a former Soul as the Soul X11 brought over, for its owner only', async () => {
  // Two people sign in once, so the store knows their accounts; then, with directoryd stopped, X11 writes its import.
  let d = await directoryd();
  for (const person of ['Ada owner', 'Someone else']) assert.equal((await post(d.origin, '/v1/account/souls', { test_person: person })).status, 200);
  await d.stop();
  const db = new DatabaseSync(store);
  const account = (subject) => db.prepare('SELECT account_id FROM provider_accounts_v1 WHERE subject = ?').get(subject).account_id;
  const scope = randomBytes(16).toString('hex');
  // X11's private tables, in its shape (v2/tools/import-accounts/src/lib.rs), and its row for Ada.
  db.exec(`CREATE TABLE IF NOT EXISTS imported_souls_v1(world TEXT NOT NULL, old_soul TEXT NOT NULL, soul TEXT NOT NULL UNIQUE,
      PRIMARY KEY(world, old_soul));
    CREATE TABLE IF NOT EXISTS souls_v1(soul TEXT PRIMARY KEY, account_id TEXT NOT NULL
      REFERENCES provider_accounts_v1(account_id), name TEXT NOT NULL, description TEXT NOT NULL, family TEXT NOT NULL,
      preset TEXT NOT NULL, look TEXT NOT NULL);`);
  db.prepare('INSERT INTO imported_souls_v1(world, old_soul, soul) VALUES (?, ?, ?)').run('eden', 's_ada', `${scope}:0`);
  db.prepare('INSERT INTO souls_v1 VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${scope}:0`, account('Ada owner'), 'Ada', '', 'eden:humanoid', 'default', 'ab'.repeat(32));
  db.close();
  d = await directoryd();

  // The request is checked: a former Soul names its world, and names nothing else.
  const ask = { secret_hash: 'cd'.repeat(32), device: 'studio laptop', label: 'test agent', scope: 'soul' };
  assert.deepEqual((await post(d.origin, '/v1/pair/request', { ...ask, former: 's_ada' })).body, { refused: 'world' });
  assert.deepEqual((await post(d.origin, '/v1/pair/request', { ...ask, former: 's_ada', world: 'eden', new: true })).body, { refused: 'request' });
  assert.deepEqual((await post(d.origin, '/v1/pair/request', { ...ask, former: '../x', world: 'eden' })).body, { refused: 'former' });

  // R18's client, as `souls.mjs upgrade` runs it; the owner approves from the card, signed in.
  const cards = [];
  const approve = (person) => async ({ code }) => {
    cards.push((await post(d.origin, '/v1/pair/show', { code, test_person: person })).body);
    return post(d.origin, '/v1/pair/approve', { code, confirm: true, test_person: person });
  };
  const run = (former, person) => {
    let approved;
    return pairFormer({
      directory: d.origin, world: 'eden', former, device: 'studio laptop', label: 'test agent',
      onAsk: (a) => { approved = approve(person)(a); },
      sleep: async (ms) => { await approved; await new Promise((r) => setTimeout(r, ms)); },
    }).then((got) => ({ got }), (e) => ({ refused: e.code }));
  };
  const [ada, other, nobody] = await Promise.all([run('s_ada', 'Ada owner'), run('s_ada', 'Someone else'), run('s_nobody', 'Ada owner')]);

  // The owner's approval: the Soul X11 brought over, its token, and the former id said back.
  const grant = `soul-${scope}-0`;
  assert.equal(ada.got?.grant, grant, JSON.stringify(ada));
  assert.equal(ada.got.former, 's_ada');
  assert.match(ada.got.token, new RegExp(`^${grant}\\.[0-9a-f]{64}$`));
  const hash = createHash('sha256').update(ada.got.token).digest('hex');
  assert.ok(readFileSync(tokens, 'utf8').split('\n').includes(`${grant} ${hash}`), 'the gateway knows the new token');
  assert.ok(cards.some((c) => c.former === 's_ada' && c.soul === null), 'the card names the former Soul');
  const listed = (await post(d.origin, '/v1/account/souls', { test_person: 'Ada owner' })).body.souls;
  assert.deepEqual(listed.map((s) => [s.soul, s.device, s.world]), [[grant, 'studio laptop', 'eden']]);
  // Another account, or a former id X11 did not bring over: refused by name, and no Soul is made.
  assert.deepEqual([other, nobody], [{ refused: 'unknown-soul' }, { refused: 'unknown-soul' }]);
  assert.deepEqual((await post(d.origin, '/v1/account/souls', { test_person: 'Someone else' })).body.souls, []);
  await d.stop();
});
