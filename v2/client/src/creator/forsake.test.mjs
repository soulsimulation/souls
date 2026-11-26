// Forsake world on a world the new engine runs (#5006 rows 16 and 38): the requests God Mode's Forsake sends
// (apps/web/src/god-ui/v2-forsake.ts) against the real directory (`directoryd` with its world list, the world-authority
// map, an archive inbox and the test sign-in), the real gateway (`gatewayd --creator-authority-required`, reading the
// world's tokens file the directory publishes) and the world's end of it (`worldd gateway-link`, a fake world with a
// body). A creator hands the world on with a one-use link that a signed-in person accepts, and the gateway follows the
// new creator; then the new creator archives it, which queues the stop and deletes nothing. Run from v2/ after
// `cargo build -p gatewayd -p worldd -p directoryd --bins --locked`.

import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stopThenRemove } from '../../../tools/teardown/stop.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const bin = (n) => process.env[n.toUpperCase().replaceAll('-', '_')] ?? join(process.env.CARGO_TARGET_DIR ?? join(v2, 'target'), 'debug', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORLD = 'forsaken';

// The authority map's paths may hold no symbolic link (a temp folder on macOS is under one), and the gateway's control
// socket sits beside the world's tokens file, under `worlds/<instance>/`: a short folder keeps it within a socket
// path's length.
const dir = realpathSync(mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'sf-')));
const lineage = randomBytes(16).toString('hex');
const instance = `${lineage}-${randomBytes(16).toString('hex')}-0`;
const tokens = join(dir, 'worlds', instance, 'tokens');
const inbox = join(dir, 'placement', 'requests');
const procs = [];
let directory, gateway, ada, bea;

function run(path, args, ready, env) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = ready.exec(out); if (m) ok(m); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => fail(new Error(`${path} ended (${c}): ${out}`)));
  });
}
const stop = (p) => new Promise((ok) => { p.once('exit', ok); p.kill('SIGTERM'); });

async function waitFor(f, ms = 15_000) {
  for (const until = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(100);
  }
}

/** A request as the page sends it: JSON, signed in as the directory's world routes take a test person. */
async function page(path, who, body) {
  const r = await fetch(`http://${directory}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer test:${who}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
/** The gateway's creator exchange (what God Mode's socket signs in with): the grant, or the refusal's name. */
async function exchange(who) {
  const r = await fetch(`http://${gateway}/v2/creator-token`, { method: 'POST', headers: { authorization: `Bearer test:${who}` } });
  const b = await r.json();
  return r.ok ? b.grant : b.refused;
}
const listed = async () => ((await (await fetch(`http://${directory}/v1/worlds`)).json()).worlds ?? []).some((w) => w.name === WORLD);
const grantOf = (principal) => `creator-${principal.replace(':', '-')}`;

before(async () => {
  const env = { PATH: process.env.PATH };
  const accounts = ['--store', join(dir, 'accounts.db'), '--pairing', join(dir, 'pairing.db'), '--test-sign-in', '--public-url', 'http://127.0.0.1:1'];
  // The two people, signed in once, as run.sh makes its creator: the directory picks each principal on first sign-in.
  const first = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', ...accounts], /listening on (\S+)\n/, env);
  const signIn = async (name) => (await (await fetch(`http://${first[1]}/v1/account/test-sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json()).principal;
  [ada, bea] = [await signIn('Ada'), await signIn('Bea')];
  await stop(procs.pop());
  assert.match(ada, /^[0-9a-f]{32}:\d+$/);

  // The world placed as an imported world is: its name record and row (register-world), its authority map entry, its
  // folder with a tokens file, and an archive inbox (the placement initializer's, which only an operator's root unit
  // drains on the machine).
  mkdirSync(join(dir, 'worlds', instance), { recursive: true });
  writeFileSync(tokens, '');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(join(dir, 'templates'));
  mkdirSync(join(dir, 'store'));
  const store = { ...env, DIRECTORYD_WORLD_STORE: join(dir, 'store') };
  await promisify(execFile)(bin('register-world'), [WORLD, '--instance', instance, '--creator', ada, '--label', 'Forsaken'], { env: store });
  writeFileSync(join(dir, 'authority.json'), JSON.stringify({ format: 'souls/world-authority/1', worldsRoot: dir, worlds: { [WORLD]: { instance, creator: ada } } }));
  [, directory] = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', ...accounts], /listening on (\S+)\n/, {
    ...store, DIRECTORYD_TEMPLATES: join(dir, 'templates'), DIRECTORYD_AUTHORITY_MAP: join(dir, 'authority.json'), DIRECTORYD_PLACEMENT: join(dir, 'placement') });
  await waitFor(() => readFileSync(tokens, 'utf8').includes(`# souls-creator/1 0 ${ada}`));

  const world = join(dir, 'w.sock');
  mkdirSync(join(dir, 'receipts'));
  procs.push(spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', lineage, '--epoch', '1', '--rooms', '1', '--bodies', '1',
    '--creator', ada.replace(':', '-'), '--no-measures'], { stdio: 'ignore' }));
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  [, gateway] = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`,
    '--receipts', join(dir, 'receipts'), '--creator', ada.replace(':', '-'), '--directory', directory, '--creator-authority-required'], /listening (\S+)\n/);
});

after(async () => { await stopThenRemove(procs, dir); });

test('the creator hands the world on with a one-use link; a signed-in person accepts; the gateway follows', async () => {
  assert.equal(await exchange('Ada'), grantOf(ada));
  assert.equal(await exchange('Bea'), 'not-the-creator');
  assert.deepEqual(await page('/v1/worlds/handoff/offer', 'Bea', { world: WORLD }), { status: 403, body: { refused: 'not-the-creator' } });

  // a cancelled link cannot be accepted
  const first = await page('/v1/worlds/handoff/offer', 'Ada', { world: WORLD });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(first.body.code, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(await page('/v1/worlds/handoff/cancel', 'Ada', { world: WORLD }), { status: 200, body: { cancelled: true } });
  assert.deepEqual(await page('/v1/worlds/handoff/accept', 'Bea', { world: WORLD, code: first.body.code }), { status: 409, body: { refused: 'handoff-unknown' } });

  const offer = await page('/v1/worlds/handoff/offer', 'Ada', { world: WORLD });
  assert.deepEqual(await page('/v1/worlds/handoff/accept', 'Bea', { world: WORLD, code: offer.body.code }), { status: 200, body: { accepted: true, world: WORLD } });
  assert.deepEqual(await page('/v1/worlds/handoff/accept', 'Bea', { world: WORLD, code: offer.body.code }), { status: 409, body: { refused: 'handoff-used' } }, 'one use');

  // one creator: the gateway signs in the new one and refuses the old, from the tokens file the directory wrote
  await waitFor(async () => (await exchange('Bea')) === grantOf(bea));
  assert.equal(await exchange('Ada'), 'not-the-creator');
  assert.match(readFileSync(tokens, 'utf8'), new RegExp(`^# souls-creator/1 1 ${bea}$`, 'm'));
  assert.deepEqual(await page('/v1/worlds/handoff/offer', 'Ada', { world: WORLD }), { status: 403, body: { refused: 'not-the-creator' } });
  assert.ok(await listed(), 'the world stays on the list');
});

test('the creator archives the world: the stop is queued once, it leaves the list, and nothing is deleted', async () => {
  assert.deepEqual(await page('/v1/worlds/archive', 'Ada', { world: WORLD, confirm: WORLD }), { status: 403, body: { refused: 'not-the-creator' } }, 'a former creator cannot');
  assert.deepEqual(await page('/v1/worlds/archive', 'Bea', { world: WORLD, confirm: 'Forsaken' }), { status: 409, body: { refused: 'archive-confirmation' } });
  assert.deepEqual(readdirSync(inbox), [], 'a refused archive queues nothing');

  const asked = await page('/v1/worlds/archive', 'Bea', { world: WORLD, confirm: WORLD });
  assert.deepEqual(asked, { status: 202, body: { pending: true, world: WORLD } });
  const queued = readdirSync(inbox);
  assert.equal(queued.length, 1);
  assert.match(queued[0], /^[0-9a-f]{64}$/);
  assert.deepEqual(await page('/v1/worlds/archive', 'Bea', { world: WORLD, confirm: WORLD }), asked, 'asking again reads the same request');
  assert.deepEqual(readdirSync(inbox), queued);

  assert.equal(await listed(), false, 'off the list while it stops');
  assert.deepEqual(await page('/v1/worlds/handoff/offer', 'Bea', { world: WORLD }), { status: 409, body: { refused: 'world-archived' } });
  // nothing deleted: the world's folder, its tokens, its name record and its row are all still there
  assert.ok(existsSync(tokens));
  assert.ok(existsSync(join(dir, 'store', 'world-name', WORLD)), 'its name record');
  assert.ok(JSON.parse(readFileSync(join(dir, 'store', 'world-list'), 'utf8')).worlds.some((w) => w.name === WORLD && w.lineage === lineage), 'its row');
  assert.equal(await exchange('Bea'), grantOf(bea), 'until the operator\'s unit stops it, the world and its gateway run on');
});
