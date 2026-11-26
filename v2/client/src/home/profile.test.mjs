// #3707: the agent sets its Soul's profile, asks to retire it and revokes it, from the client, against the real
// directory (`directoryd` with the sign-in for test worlds). The owner's page is played by its signed-in POSTs. Run
// from v2/ after `cargo build -p directoryd --locked`.
import { strict as assert } from 'node:assert';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { soulRetireWait } from '../account/account.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const CLI = join(v2, 'client/src/cli/souls.mjs');
const dir = mkdtempSync(join(tmpdir(), 'souls-3707-'));
const procs = [];
let directory, tokensFile;

const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** A small PNG, `side` px square, one colour. */
function png(side) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(side, 0); head.writeUInt32BE(side, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(side * 3, 0x80)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head),
    chunk('IDAT', deflateSync(Buffer.concat(Array(side).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** What the owner's page does: a POST, signed in as W1's test person. */
async function page(path, body = {}) {
  const r = await fetch(new URL(path, directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, test_person: 'owner' }) });
  return { status: r.status, body: await r.json() };
}
const mine = async () => (await page('/v1/account/souls')).body.souls;

/** The thin command in `home`, as an agent runs it: its one JSON line. */
function souls(home, ...args) {
  return new Promise((ok, fail) => execFile(process.execPath, [CLI, ...args], { cwd: dir, env: { PATH: process.env.PATH, SOULS_HOME: home } },
    (e, out, err) => { try { ok(JSON.parse(out.trim().split('\n').at(-1))); } catch { fail(e ?? new Error(err)); } }));
}

/** Pairs a Soul into `home` with W2's pairing and the owner's approval: its local id and grant. */
async function paired(home) {
  const p = spawn(process.execPath, [join(v2, 'client/src/pair/pair.mjs'), '--directory', directory, '--world', 'local',
    '--gateway', 'ws://127.0.0.1:1/v2/ws', '--device', 'test machine', '--label', 'test agent'], { env: { PATH: process.env.PATH, SOULS_HOME: home } });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((ok) => { const t = setInterval(() => { const m = /"code":"([A-Z-]+)"/.exec(out); if (m) { clearInterval(t); ok(m[1]); } }, 20); });
  assert.equal((await page('/v1/pair/approve', { code, confirm: true })).status, 200);
  await new Promise((ok) => p.on('exit', ok));
  const said = JSON.parse(out.trim().split('\n').at(-1));
  return { soul: said.soul, grant: said.grant };
}

before(async () => {
  tokensFile = join(dir, 'gateway-tokens.txt');
  const port = await freePort();
  directory = `http://127.0.0.1:${port}`;
  const d = spawn(bin('directoryd'), ['--listen', `127.0.0.1:${port}`, '--public-url', directory, '--store', join(dir, 'accounts.sqlite'),
    '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'), '--gateway-tokens', tokensFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(d);
  await new Promise((ok, fail) => { let o = ''; d.stdout.on('data', (b) => { o += b; if (/listening on/.test(o)) ok(); }); d.stderr.on('data', (b) => { o += b; }); d.on('exit', () => fail(new Error(o))); });
});

after(() => {
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('A1: the agent sets its Soul\'s name, description and photo, and the owner\'s page shows them', async () => {
  const home = join(dir, 'a1');
  const { soul, grant } = await paired(home);
  assert.deepEqual((await souls(home, 'profile')).profile, { name: null, description: null, photo: 'auto', retireAsked: false });
  assert.equal((await souls(home, 'profile', 'name', 'Oriel')).profile.name, 'Oriel');
  const described = await souls(home, 'profile', 'description', 'Quiet', 'and', 'curious.');
  assert.deepEqual([described.ok, described.soul, described.profile.description], [true, soul, 'Quiet and curious.']);
  const photo = join(dir, 'face.png');
  writeFileSync(photo, png(16));
  assert.equal((await souls(home, 'profile', 'photo', photo)).profile.photo, 'png');
  const row = (await mine()).find((s) => s.soul === grant);
  assert.deepEqual([row.name, row.description], ['Oriel', 'Quiet and curious.']);
  assert.match(row.picture, /^data:image\/png;base64,/);
  // auto: the page draws its own picture again; a refused change names why and keeps the profile.
  assert.equal((await souls(home, 'profile', 'photo', 'auto')).profile.photo, 'auto');
  assert.equal((await mine()).find((s) => s.soul === grant).picture, null);
  const long = await souls(home, 'profile', 'description', 'x'.repeat(281));
  assert.deepEqual([long.ok, long.code], [false, 'description']);
  assert.equal((await souls(home, 'profile', 'colour', 'red')).code, 'profile-usage');
  assert.equal((await mine()).find((s) => s.soul === grant).description, 'Quiet and curious.');
});

test('A2: retire asks and the owner\'s click decides; revoke disconnects the agent; list --account lists the Souls', async () => {
  const home = join(dir, 'a2');
  const first = await paired(home);
  await souls(home, 'profile', 'name', 'Wren');
  // An agent's retire changes nothing but the ask, shown on the page.
  const asked = await souls(home, 'retire', 'Wren');
  assert.deepEqual([asked.ok, asked.retire, asked.soul], [true, 'asked', first.soul]);
  // 0.137: the owner confirms on the Soul's card on its world's page; there is no separate Souls page.
  assert.equal(asked.page, `${directory}/w/local/#soul/${first.soul}`);
  assert.match(asked.next, /press Retire for good on its card/);
  assert.doesNotMatch(asked.next, /Souls page/);
  // Not confirmed yet: `retire wait` comes back at its bound (a minute; here at once), still pending.
  const pending = await soulRetireWait(home, { within: 0 });
  assert.deepEqual([pending.retire, pending.next], ['pending', 'retire wait']);
  assert.equal((await mine()).find((s) => s.soul === first.grant).retire_asked, true);
  const hash = (token) => createHash('sha256').update(token).digest('hex');
  const token = Object.values(json(join(home, 'credentials.json')).souls[first.soul])[0].token;
  assert.ok(readFileSync(tokensFile, 'utf8').includes(hash(token)), 'the token still works');
  // The owner confirms on the page; `retire wait` sees it, and the dead token leaves the home.
  assert.equal((await page('/v1/account/souls/retire', { soul: first.grant, confirm: true })).status, 200);
  // The world hears of it from the directory's Souls file beside the gateway's tokens (worldd directory.rs), and the
  // gateway no longer takes its token.
  assert.match(readFileSync(`${tokensFile}.souls`, 'utf8'), new RegExp(`^retired ${first.grant}$`, 'm'));
  assert.ok(!readFileSync(tokensFile, 'utf8').includes(hash(token)), 'the gateway refuses its token');
  const waited = await souls(home, 'retire', 'wait');
  assert.deepEqual([waited.retire, waited.retired], ['done', true]);
  assert.equal(json(join(home, 'credentials.json')).souls?.[first.soul], undefined);
  assert.ok(!(await mine()).some((s) => s.soul === first.grant), 'off the list');

  // revoke needs the account login, as today's.
  const second = await paired(home);
  mkdirSync(join(home, 'souls', second.soul, 'memory'), { recursive: true });
  writeFileSync(join(home, 'souls', second.soul, 'memory', 'journal.md'), 'kept');
  assert.equal((await souls(home, 'revoke', second.soul)).code, 'account-not-connected');
  const ask = await souls(home, 'login', directory);
  const request = new URL(ask.link).searchParams.get('request');
  assert.equal((await page(`/v1/account/requests/${request}/approve`, { confirm: true })).status, 200);
  assert.equal((await souls(home, 'login', '--wait')).connected, true);
  const listed = await souls(home, 'list', '--account');
  assert.ok(listed.souls.some((s) => s.id === second.grant && s.device === 'test machine'), JSON.stringify(listed));
  const secondToken = Object.values(json(join(home, 'credentials.json')).souls[second.soul])[0].token;
  const revoked = await souls(home, 'revoke', second.soul);
  assert.deepEqual([revoked.ok, revoked.revoked, revoked.soul.id, revoked.here], [true, true, second.grant, 'unpaired; its memory stays here']);
  assert.ok(!readFileSync(tokensFile, 'utf8').includes(hash(secondToken)), 'the gateway refuses its token');
  assert.equal(json(join(home, 'credentials.json')).souls?.[second.soul], undefined);
  assert.equal(readFileSync(join(home, 'souls', second.soul, 'memory', 'journal.md'), 'utf8'), 'kept');
  assert.equal((await souls(home, 'list', '--account')).souls.find((s) => s.id === second.grant).device, null);
  assert.equal((await souls(home, 'revoke', 'nobody')).code, 'not-yours');
});

test('A3: the owner\'s Keep on the card clears the agent\'s ask; `retire wait` hears the Soul was kept (0.137)', async () => {
  const home = join(dir, 'a3');
  const { soul, grant } = await paired(home);
  assert.equal((await souls(home, 'retire', soul)).retire, 'asked');
  assert.equal((await soulRetireWait(home, { within: 0 })).retire, 'pending');
  assert.equal((await page('/v1/account/souls/keep', { soul: grant })).status, 200);
  assert.equal((await mine()).find((s) => s.soul === grant).retire_asked, false);
  const kept = await souls(home, 'retire', 'wait');
  assert.deepEqual([kept.ok, kept.retire, kept.retired, kept.why], [true, 'kept', false, 'Your person kept it. Nothing changed.']);
  assert.ok(json(join(home, 'credentials.json')).souls?.[soul], 'still paired here');
  assert.equal((await souls(home, 'retire', 'wait')).code, 'no-retire', 'nothing left to wait for');
});
