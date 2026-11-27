// give-world.mjs on a stand-in machine (GIVE_ROOT): the directory's store made with directoryd's own schema, a
// world-authority map, world folders and gateway files as production has them, systemctl a script that logs, and a
// /healthz the test answers. The end-to-end run with the real directoryd and gatewayd: tests/give-world-e2e.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'give-world.mjs');
const ORPHAN = `${'9'.repeat(32)}:0`, OLD = `${'2'.repeat(32)}:0`, OTHER = `${'5'.repeat(32)}:0`;
const GENE = 'acct_00000000-0000-4000-8000-000000000001', DIMI = 'acct_00000000-0000-4000-8000-000000000002';
const inst = (c) => `${c.repeat(32)}-${c.repeat(32)}-0`;
// directoryd's account tables (v2/crates/directoryd/src/accounts/store.rs), as it makes them.
const SCHEMA = `CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(issuer, subject));
CREATE TABLE account_principals_v1(account_id TEXT PRIMARY KEY REFERENCES provider_accounts_v1(account_id),
  principal_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE account_grants_v1(account_id TEXT NOT NULL REFERENCES provider_accounts_v1(account_id),
  grant_text TEXT NOT NULL, follow TEXT, UNIQUE(account_id, grant_text));`;

async function machine({ worlds, principals = [], grants = [] }) {
  const scratch = resolve('.local'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'give-world-'));
  const server = createServer((q, s) => { s.statusCode = q.url === '/healthz' ? 200 : 404; s.end('{}'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const listen = `127.0.0.1:${server.address().port}`;
  const etc = join(root, 'etc/souls'), data = join(root, 'var/lib/souls');
  mkdirSync(join(etc, 'placement-data'), { recursive: true }); mkdirSync(join(data, 'directory'), { recursive: true });
  writeFileSync(join(etc, 'directory.args'), `DIRECTORYD_ARGS=--listen ${listen} --store /var/lib/souls/directory/accounts.sqlite\n`);
  const map = { format: 'souls/world-authority/1', aliases: { 'eden-2026': 'eden' }, worlds: {}, worldsRoot: '/var/lib/souls/worlds' };
  for (const [name, i, creator, flags] of worlds) {
    map.worlds[name] = { creator, instance: i };
    const f = join(data, 'worlds/worlds', i); mkdirSync(f, { recursive: true });
    writeFileSync(join(f, 'world.json'), JSON.stringify({ format: 'souls/world/1', name: i, creator: creator.replace(':', '-') }));
    writeFileSync(join(f, 'tokens'), `# World-bound pairing authority\n# souls-creator/1 0 ${creator}\n`);
    writeFileSync(join(etc, `gateway-${i}.env`), `GATEWAYD_ARGS=--listen 127.0.0.1:7400 --world /var/lib/souls/run/${i}.sock${flags ?? ''} --view-key /etc/souls/view.key\n`);
  }
  writeFileSync(join(etc, 'placement-data/authority.json'), JSON.stringify(map));
  const db = new DatabaseSync(join(data, 'directory/accounts.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; ${SCHEMA}`);
  for (const a of [GENE, DIMI]) db.prepare('INSERT INTO provider_accounts_v1 VALUES(?,?,?,1)').run(a, 'test:local', a);
  for (const [a, p] of principals) db.prepare('INSERT INTO account_principals_v1 VALUES(?,?,1)').run(a, p);
  for (const [a, g] of grants) db.prepare('INSERT INTO account_grants_v1 VALUES(?,?,NULL)').run(a, g);
  db.close();
  const log = join(root, 'systemctl.log'), stub = join(root, 'systemctl');
  writeFileSync(stub, `#!/bin/sh\necho "$*" >> '${log}'\n`); chmodSync(stub, 0o755);
  // Not spawnSync: the test's /healthz must answer while the script runs.
  const give = (...args) => new Promise((ok) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, GIVE_ROOT: root, GIVE_SYSTEMCTL: stub, GIVE_STAMP: 'T1' } });
    let stdout = '', stderr = ''; c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('exit', (status) => ok({ status, stdout, stderr: stderr.replace(/^.*ExperimentalWarning.*\n(.*--trace-warnings.*\n)?/m, '') }));
  });
  const rows = () => { const d = new DatabaseSync(join(data, 'directory/accounts.sqlite'), { readOnly: true });
    try { return { principals: d.prepare('SELECT account_id a, principal_id p FROM account_principals_v1 ORDER BY 1').all().map((r) => `${r.a} ${r.p}`),
      grants: d.prepare('SELECT account_id a, grant_text g FROM account_grants_v1 ORDER BY 1, 2').all().map((r) => `${r.a} ${r.g}`) }; } finally { d.close(); } };
  return { root, etc, data, give, rows, listen, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    env: (i) => readFileSync(join(etc, `gateway-${i}.env`), 'utf8'),
    done: async () => { await new Promise((ok) => server.close(ok)); rmSync(root, { recursive: true, force: true }); } };
}

test('Eden as on 27 Nov: the account gives up a principal that creates nothing, takes the orphan creator, and its gateway gets the flags', async () => {
  const m = await machine({ worlds: [['eden', inst('a'), ORPHAN]], principals: [[GENE, OLD]], grants: [[GENE, `creator-${OLD.replace(':', '-')}`], [GENE, 'soul-x-0']] });
  try {
    const before = m.rows(), envBefore = m.env(inst('a'));
    const check = await m.give('eden-2026', GENE, 'check');
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /gives up its principal/);
    assert.match(check.stdout, new RegExp(`add --creator ${'9'.repeat(32)}-0 --directory ${m.listen} --creator-authority-required`));
    assert.deepEqual([m.rows(), m.env(inst('a')), m.calls()], [before, envBefore, []], 'check changes nothing');

    const run = await m.give('eden', GENE, 'run');
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.deepEqual(m.rows(), { principals: [`${GENE} ${ORPHAN}`], grants: [`${GENE} creator-${'9'.repeat(32)}-0`, `${GENE} soul-x-0`] }, 'the Soul grant stays');
    assert.equal(m.env(inst('a')), `GATEWAYD_ARGS=--listen 127.0.0.1:7400 --world /var/lib/souls/run/${inst('a')}.sock --view-key /etc/souls/view.key --creator ${'9'.repeat(32)}-0 --directory ${m.listen} --creator-authority-required\n`);
    assert.equal(readFileSync(join(m.etc, `gateway-${inst('a')}.env.before-creator-T1`), 'utf8'), envBefore, 'the gateway file backed up');
    const backup = new DatabaseSync(join(m.data, 'directory/accounts.sqlite.before-give-eden-T1'), { readOnly: true });
    assert.equal(backup.prepare('SELECT principal_id p FROM account_principals_v1').get().p, OLD, 'the store backed up before the write'); backup.close();
    assert.deepEqual(m.calls(), ['stop souls-directory.service', 'start souls-directory.service', `restart souls-gateway@${inst('a')}.service`, `is-active --quiet souls-gateway@${inst('a')}.service`]);

    const again = await m.give('eden', GENE, 'run');
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /no change[\s\S]*no change/);
    assert.equal(m.calls().length, 4, 'a second run stops and restarts nothing');
  } finally { await m.done(); }
});

test('production after the Eden fix: the account already holds the creator, so only the other worlds\' gateways change, and the directory is left running', async () => {
  const m = await machine({ worlds: [['eden', inst('a'), ORPHAN, ` --creator ${'9'.repeat(32)}-0 --directory 127.0.0.1:7310 --creator-authority-required`], ['rna-studio', inst('b'), ORPHAN]],
    principals: [[GENE, ORPHAN]], grants: [[GENE, `creator-${'9'.repeat(32)}-0`]] });
  try {
    const run = await m.give('rna-studio', GENE, 'run');
    assert.equal(run.status, 0, run.stderr);
    assert.match(m.env(inst('b')), / --creator 9{32}-0 --directory 127\.0\.0\.1:\d+ --creator-authority-required\n$/);
    assert.deepEqual(m.calls(), [`restart souls-gateway@${inst('b')}.service`, `is-active --quiet souls-gateway@${inst('b')}.service`]);
    assert.ok(!readdirSync(join(m.data, 'directory')).some((f) => f.includes('before-give')), 'no store change, no store backup');
  } finally { await m.done(); }
});

test('refusals change nothing: a principal another account holds, an account whose principal creates a world, a gateway naming another creator', async () => {
  const m = await machine({ worlds: [['rna-studio', inst('b'), ORPHAN], ['mars-lab', inst('c'), OLD], ['odd', inst('d'), OTHER, ` --creator ${'1'.repeat(32)}-0`]],
    principals: [[GENE, ORPHAN], [DIMI, OLD]] });
  try {
    const before = m.rows();
    const held = await m.give('rna-studio', DIMI, 'run');
    assert.equal(held.status, 3); assert.match(held.stderr, /^refused: principal-held: /);
    const creates = await m.give('odd', DIMI, 'run');
    assert.equal(creates.status, 3); assert.match(creates.stderr, /^refused: account-creates-other-worlds: .*mars-lab/);
    const d = new DatabaseSync(join(m.data, 'directory/accounts.sqlite')); d.prepare('DELETE FROM account_principals_v1 WHERE account_id=?').run(DIMI); d.close();
    const differs = await m.give('odd', DIMI, 'run');
    assert.equal(differs.status, 3); assert.match(differs.stderr, /^refused: gateway-creator-differs: /);
    assert.equal((await m.give('nowhere', DIMI, 'check')).status, 3);
    assert.deepEqual(m.rows().grants, before.grants);
    assert.deepEqual(m.calls(), [], 'nothing stopped or restarted');
  } finally { await m.done(); }
});

test('place-world.sh gives an imported world (a creator, no --directory) its creator flags', () => {
  const root = mkdtempSync(join(resolve('.local'), 'give-world-place-')), seeded = join(root, 'seeded'), i = inst('e');
  try {
    mkdirSync(seeded);
    writeFileSync(join(seeded, 'world.json'), JSON.stringify({ format: 'souls/world/1', name: i, creator: `${'9'.repeat(32)}-0` }));
    const r = spawnSync('bash', [join(import.meta.dirname, 'place-world.sh'), seeded, '--port', '7400'], { encoding: 'utf8', env: { PATH: process.env.PATH, PLACE_ROOT: join(root, 'm') } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(root, 'm/etc/souls', `gateway-${i}.env`), 'utf8'), / --creator 9{32}-0 --directory 127\.0\.0\.1:7310 --creator-authority-required /);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
