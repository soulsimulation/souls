// #5024 finding 1: right after the world's owner approved a creator pairing, the agent's first command was refused
// `which-creator` ("creators here: none"), because the detached pairing had not yet collected its token on its next
// poll. A fake directory answers the poll only a while after the approval, as the real one does (5 s interval), and
// the creator's command sent at the approval must wait for the pairing, not refuse.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { afterPairing, pairingOf } from './souls-god.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GOD = join(here, 'souls-god.mjs');
const root = mkdtempSync(join(here, '../../../../.local/pairing-wait-'));
after(() => rmSync(root, { recursive: true, force: true }));
const GRANT = `creator-${'ab'.repeat(16)}-4`;

const god = (home, ...args) => new Promise((ok) => {
  execFile(process.execPath, [GOD, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home } }, (_, stdout) => ok(JSON.parse(stdout.trim().split('\n').at(-1))));
});

test('the first command after the owner approves waits for the pairing and answers as the creator', async () => {
  let approved = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/pair/request') return res.end(JSON.stringify({ code: 'BCDF-GHJK', link: '/pair?request=1', interval: 1 }));
      if (req.url === '/v1/pair/poll') {
        if (!approved) return res.end(JSON.stringify({ pending: 'authorization_pending' }));
        // The token reaches the home only a while after the approval: the pairing's next poll.
        return setTimeout(() => res.end(JSON.stringify({ token: `${GRANT}.${'cd'.repeat(32)}`, grant: GRANT })), 1500);
      }
      if (req.url === '/v1/worlds/visitors') return res.end(JSON.stringify({ visitors: [], authorized: req.headers.authorization?.startsWith('Bearer ') }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const home = join(root, 'race', '.souls');
  try {
    const paired = await god(home, 'pair', `http://127.0.0.1:${server.address().port}/w1`, '--creator', GRANT);
    assert.equal(paired.code, 'BCDF-GHJK', JSON.stringify(paired));
    assert.equal(pairingOf(home).state, 'waiting');
    approved = true;
    const said = await god(home, 'visitors');
    assert.equal(said.ok, true, `the command at the approval answers as the creator, not ${JSON.stringify(said)}`);
    assert.equal(said.authorized, true);
    assert.equal(pairingOf(home), null, 'the pairing is done');
  } finally { server.close(); }
});

test('while the owner has not approved, the answer says the pairing is waiting, in plain words', async () => {
  const home = join(root, 'waiting');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'pairing.log'), JSON.stringify({ ok: true, step: 'approve', link: 'x', code: 'BCDF-GHJK' }) + '\n');
  writeFileSync(join(home, 'pairing.pid'), String(process.pid));
  const said = await afterPairing(home, { within: 300, step: 50 });
  assert.equal(said.code, 'pairing-waiting');
  assert.match(said.detail, /code BCDF-GHJK\) is waiting for the world's owner to approve it/);
  // A pairing whose process is gone with no answer, or one the directory refused, says to pair again.
  assert.equal((await afterPairing(home, { alive: () => false })).code, 'pairing-ended');
  writeFileSync(join(home, 'pairing.log'), JSON.stringify({ ok: false, code: 'pair-denied' }) + '\n', { flag: 'a' });
  assert.match((await afterPairing(home)).detail, /refused \(pair-denied\)/);
  // No pairing at all: the command says to pair first, not to name a creator.
  const none = await god(join(root, 'none'), 'visitors');
  assert.equal(none.code, 'no-creator');
  assert.match(none.fix, /pair first/);
});
