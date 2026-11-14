// #2246: the published eden.mjs against the real server app (#2243's routes, account-grant/1 in #2242), as a person meets
// it with two computers: log in once on each, and a Soul moves between them with no code and no click. Only the sign-in
// provider is synthetic. This is the proof that #2244's client and #2243's server agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { fixture } from '../test/native-owner-fixture.ts';
import { buildApp } from './http.ts';
import type { Hub } from './hub.ts';
import type { AccountIdentity } from './accounts/store.ts';
import { marsFactory, GREEN_FIELD_WORLD } from '@souls/engine-mars';

const CLI = fileURLToPath(new URL('../../../tools/world-launcher/soul/eden.mjs', import.meta.url));

async function site(t: { after: (f: () => unknown) => void }) {
  const f = fixture(':memory:', await marsFactory({ ...GREEN_FIELD_WORLD, safeCrewRemoval: true })); f.brain.quiesce(); f.souls.enableLifecycle();
  f.souls.cfg.accountAuthRequired = true; f.souls.cfg.inviteRequired = false;
  const who = (name: string): AccountIdentity => ({ id: `account-${name}`, issuer: 'fixture', subject: `account-${name}`, verifiedAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
  f.auth.accountFromToken = async token => {
    const m = /^owner:(\w+)$/.exec(token ?? ''); if (!m) return null;
    const identity = who(m[1]!); f.db.upsertUser({ id: identity.id, email: null, wallet: null, role: 'user' });
    return { identity, user: f.db.user(identity.id)! };
  };
  const app = buildApp({ cfg: f.souls.cfg, db: f.db, host: f.host, souls: f.souls, brain: f.brain, auth: f.auth, hub: { clients: new Map(), refreshMe() {} } as unknown as Hub });
  const listener = getRequestListener(app.fetch);
  const server = createServer((req, res) => { req.url = req.url!.replace(/^\/w\/test/, '') || '/'; listener(req, res); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const root = mkdtempSync(join(tmpdir(), 'cli-account-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); f.host.stop(); f.db.close(); });
  const world = `http://127.0.0.1:${(server.address() as { port: number }).port}/w/test`;
  /** What the person does in their signed-in window. Each call is one click. */
  const clicks: string[] = [];
  const owner = (name: string, path: string) => { clicks.push(path); return app.request(path, { method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json', authorization: `Bearer owner:${name}` }, body: '{}' }); };
  const code = async (name = 'gene') => (await (await owner(name, '/v1/account/window-code')).json() as { code: string }).code;
  const folder = (name: string) => {
    const dir = join(root, name); mkdirSync(dir, { recursive: true }); copyFileSync(CLI, join(dir, 'eden.mjs'));
    const raw = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => execFile(process.execPath, ['eden.mjs', ...args], { cwd: dir, env: { ...process.env, HOME: dir, SOULS_HOME: '', SOULS_PRINCIPAL: '' } }, (e, out, err) => resolve({ code: e ? (e.code as number) ?? 1 : 0, out, err })));
    const run = async (...args: string[]) => { const r = await raw(...args); assert.equal(r.code, 0, `${args.join(' ')}: ${r.err || r.out}`); return JSON.parse(r.out) as Record<string, any>; };
    const config = () => JSON.parse(readFileSync(join(dir, '.souls', 'config.json'), 'utf8'));
    return { dir, raw, run, config };
  };
  /** login, the person approves it in their window, login wait. */
  const logIn = async (h: ReturnType<typeof folder>, ...args: string[]) => {
    const asked = await h.run('login', ...args);
    assert.equal(asked.login, 'pending'); assert.match(asked.confirm, /^[A-HJ-NP-Z2-9]{4}$/); assert.ok(asked.approvalURL.endsWith(`/#approve/${asked.requestId}`));
    const approved = await owner('gene', `/v1/account/requests/${asked.requestId}/approve`);
    assert.equal(approved.status, 200, await approved.clone().text());
    const done = await h.run('login', 'wait');
    assert.equal(done.login, 'connected'); assert.match(done.account, /^account-gene$/);
    return done;
  };
  return { f, world, owner, code, clicks, folder, logIn };
}

test('A5: log in once on each computer; a Soul moves with no code, the first computer says where it went, retire takes one click', async t => {
  const s = await site(t), one = s.folder('one'), two = s.folder('two');
  // Today's way in: a window code and one approval. Wren lives in home one, untagged.
  await one.run('register', s.world);
  const made = await one.run('create', 'Wren', '--for', await s.code());
  assert.equal((await s.owner('gene', `/v1/account/approvals/${made.approvalId}/approve`)).status, 200);
  const wren = (await one.run('approval', 'wait')).soul as { id: string; name: string };
  // login and its approval; list --account shows Wren held by home one, with `agent` as {label, since}.
  await s.logIn(one, '--device', 'one');
  const listed = await one.run('list', '--account');
  assert.deepEqual(listed.souls.map((x: any) => [x.id, x.name, x.here, x.control.held]), [[wren.id, 'Wren', true, true]]);
  assert.deepEqual(Object.keys(listed.souls[0].agent).sort(), ['label', 'since'], 'agent is {label, since} as #2242 says');
  assert.equal(typeof listed.souls[0].agent.label, 'string');
  // Home two: one login, then adopt by name. No code, and no click by the person after the login.
  await s.logIn(two, s.world, '--device', 'two');
  const clicksBefore = s.clicks.length;
  const moved = await two.run('adopt', 'Wren');
  assert.equal(moved.status, 'ready'); assert.deepEqual(moved.soul, wren); assert.equal(moved.paired, true);
  assert.equal(s.clicks.length, clicksBefore, 'the move took none of the person\'s actions');
  assert.equal(two.config().souls[wren.id].account, 'account-gene', 'tagged with the account');
  assert.equal((await two.run('status')).soul.id, wren.id, 'home two controls Wren');
  assert.equal((await two.run('adopt', 'Wren')).reconnection, 'already connected', 'run again, nothing is paired');
  const there = (await two.run('list', '--account')).souls[0];
  assert.match(there.agent.label, / on two$/);
  // Home one: status says control moved and where Wren runs, gives adopt as the way back, and unpairs Wren there.
  const left = await one.run('status');
  assert.equal(left.paired, false); assert.equal(left.control, 'replaced'); assert.match(left.why, /^Control of Wren moved to another device/); assert.equal(left.runs, there.agent.label);
  assert.equal(left.next, 'node eden.mjs adopt Wren');
  assert.equal(one.config().souls[wren.id].state, 'unpaired');
  // retire asks; the person approves it with one click; retire wait marks it retired here.
  const asked = await two.run('retire', 'Wren');
  assert.equal(asked.retire, 'pending'); assert.match(asked.confirm, /^[A-HJ-NP-Z2-9]{4}$/); assert.ok(asked.approvalURL.endsWith(`/#approve/${asked.requestId}`));
  assert.match(asked.next, /node eden\.mjs retire wait$/);
  assert.equal(s.f.db.soul(wren.id)!.retired_at, null, 'nothing is retired before the click');
  const approved = await s.owner('gene', `/v1/account/requests/${asked.requestId}/approve`);
  assert.equal(approved.status, 200, await approved.clone().text());
  const done = await two.run('retire', 'wait');
  assert.equal(done.retire, 'ready'); assert.equal(done.retired, true);
  assert.equal(two.config().souls[wren.id].state, 'retired'); assert.ok(two.config().souls[wren.id].retiredAt);
  // logout ends the login in the world and here.
  const out = await two.run('logout');
  assert.equal(out.loggedOut, 'me'); assert.equal(out.world, 'ended'); assert.deepEqual(two.config().accounts, {});
  assert.deepEqual(s.f.host.engine.runtime.violations, []);
});
