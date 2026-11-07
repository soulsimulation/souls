// #1274: the published eden.mjs against the real server app on an account world, as a person meets it after losing a
// folder: only the sign-in provider is synthetic. Re-pairing never makes a second Soul, and recovery has a next step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), 'cli-recovery-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); f.host.stop(); f.db.close(); });
  const world = `http://127.0.0.1:${(server.address() as { port: number }).port}/w/test`;
  const owner = (name: string, path: string) => app.request(path, { method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json', authorization: `Bearer owner:${name}` }, body: '{}' });
  const code = async (name = 'gene') => (await (await owner(name, '/v1/account/window-code')).json() as { code: string }).code;
  const folder = (name: string) => {
    const dir = join(root, name); mkdirSync(dir, { recursive: true }); copyFileSync(CLI, join(dir, 'eden.mjs'));
    const raw = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => execFile(process.execPath, ['eden.mjs', ...args], { cwd: dir }, (e, out, err) => resolve({ code: e ? (e.code as number) ?? 1 : 0, out, err })));
    const run = async (...args: string[]) => { const r = await raw(...args); assert.equal(r.code, 0, `${args.join(' ')}: ${r.err || r.out}`); return JSON.parse(r.out) as Record<string, any>; };
    return { dir, raw, run };
  };
  /** Register `dir`, ask for `name`, approve it, wait: the Soul exists and this folder holds it. */
  const make = async (h: ReturnType<typeof folder>, name: string, person = 'gene') => {
    await h.run('register', world);
    const asked = await h.run('create', name, '--for', await code(person));
    assert.equal((await owner(person, `/v1/account/approvals/${asked.approvalId}/approve`)).status, 200);
    return (await h.run('approval', 'wait')).soul as { id: string; name: string };
  };
  return { f, world, owner, code, folder, make };
}

test('create in a fresh folder for a Soul the account owns reconnects it; anyone else still sees name-taken', async t => {
  const s = await site(t), first = s.folder('one'), wren = await s.make(first, 'Wren');
  const fresh = s.folder('two'); await fresh.run('register', s.world);
  const noCode = await fresh.raw('create', 'Wren');
  assert.notEqual(noCode.code, 0); assert.match(noCode.err, /name-taken/); assert.ok(!noCode.err.includes(wren.id), 'no code, no id');
  const stranger = await fresh.raw('create', 'Wren', '--for', await s.code('ana'));
  assert.notEqual(stranger.code, 0); assert.match(stranger.err, /name-taken/); assert.ok(!stranger.err.includes(wren.id), "another account's code, no id");
  const asked = await fresh.run('create', 'Wren', '--for', await s.code());
  assert.equal(asked.soulId, wren.id, 'the same Soul'); assert.match(asked.reconnects, /nothing new/);
  assert.equal((await s.owner('gene', `/v1/account/approvals/${asked.approvalId}/approve`)).status, 200);
  const ready = await fresh.run('approval', 'wait');
  assert.equal(ready.soul.id, wren.id);
  assert.equal((await fresh.run('status')).soul.id, wren.id);
  assert.equal(s.f.db.soulByName(s.f.host.worldId, 'Wren')?.id, wren.id);
});

test('adopt finds a Soul by name with a window code, and never creates one', async t => {
  const s = await site(t), wren = await s.make(s.folder('one'), 'Wren');
  const fresh = s.folder('two'); await fresh.run('register', s.world);
  const bare = await fresh.raw('adopt', 'Wren');
  assert.notEqual(bare.code, 0); assert.match(bare.err, /--for <CODE>/);
  const none = await fresh.raw('adopt', 'Nobody', '--for', await s.code());
  assert.notEqual(none.code, 0); assert.match(none.err, /holds no Soul called Nobody/);
  assert.equal(s.f.db.soulByName(s.f.host.worldId, 'Nobody'), undefined, 'adopt made nothing');
  const theirs = await fresh.raw('adopt', 'Wren', '--for', await s.code('ana'));
  assert.notEqual(theirs.code, 0); assert.match(theirs.err, /holds no Soul called Wren/);
  const asked = await fresh.run('adopt', 'Wren', '--for', await s.code());
  assert.equal(asked.soulId, wren.id);
});

test('doctor --for lists what the account holds and this home lacks; without a code it says how', async t => {
  const s = await site(t), wren = await s.make(s.folder('one'), 'Wren');
  const fresh = s.folder('two'), ivo = await s.make(fresh, 'Ivo');
  const plain = await fresh.run('doctor');
  assert.deepEqual(plain.adoptable, []); assert.match(plain.worlds[0].note, /doctor --for <CODE>/);
  const listed = await fresh.run('doctor', '--for', await s.code());
  assert.deepEqual(listed.adoptable, [{ id: wren.id, name: 'Wren', world: 'test' }], 'Wren, not Ivo who is here');
  assert.ok(!JSON.stringify(listed).includes(ivo.id) || listed.adoptable.every((a: { id: string }) => a.id !== ivo.id));
  const wrong = await fresh.run('doctor', '--for', 'ZZZZ-ZZZZ');
  assert.deepEqual(wrong.adoptable, [], 'a code that means nothing lists nothing');
});

test('a home that lost its tokens names the Soul and adopt, and keeps its memory; a corrupt file says what to do', async t => {
  const s = await site(t), h = s.folder('one'), wren = await s.make(h, 'Wren');
  await h.run('remember', '--self', 'I keep bees by the mill.');
  const creds = join(h.dir, '.souls/credentials.json'), kept = readFileSync(creds);
  writeFileSync(creds, '{oops');
  const corrupt = await h.raw('status');
  assert.notEqual(corrupt.code, 0); assert.match(corrupt.err, /move it aside/); assert.equal(readFileSync(creds, 'utf8'), '{oops', 'left as it was');
  rmSync(creds);
  const st = await h.run('status');
  assert.equal(st.paired, false); assert.equal(st.soul.name, 'Wren');
  assert.match(st.next, new RegExp(`adopt ${wren.id} --for <CODE>`)); assert.ok(!st.next.includes('create'));
  assert.ok((await h.run('memory', 'bees')).matches.length, 'memory needs no token');
  const doctor = await h.run('doctor');
  assert.deepEqual(doctor.controlLost.map((c: { id: string }) => c.id), [wren.id]);
  const out = JSON.stringify([st, doctor]), token = /sim_[A-Za-z0-9_-]{8,}/;
  assert.ok(!token.test(out), 'no token in the output'); assert.ok(kept.length);
  const asked = await h.run('adopt', wren.id, '--for', await s.code());
  assert.equal((await s.owner('gene', `/v1/account/approvals/${asked.approvalId}/approve`)).status, 200);
  await h.run('approval', 'wait');
  assert.equal((await h.run('status')).paired, true);
  assert.ok((await h.run('memory', 'bees')).matches.length, 'the same memory, paired again');
});

test('a config.json moved aside is rebuilt by doctor from the Souls on disk', async t => {
  const s = await site(t), h = s.folder('one'), wren = await s.make(h, 'Wren');
  await h.run('remember', '--self', 'I keep bees by the mill.');
  const cfg = join(h.dir, '.souls/config.json');
  writeFileSync(cfg, '{oops');
  const corrupt = await h.raw('status');
  assert.notEqual(corrupt.code, 0); assert.match(corrupt.err, /run doctor/);
  renameSync(cfg, `${cfg}.broken`);
  await h.run('doctor');
  const st = await h.run('status');
  assert.equal(st.soul.id, wren.id); assert.equal(st.paired, true, 'its token was still here');
});

test('an imported Soul knows itself, reads its memory and is adopted by name with no register first', async t => {
  const s = await site(t), one = s.folder('one'), wren = await s.make(one, 'Wren');
  await one.run('remember', '--self', 'I keep bees by the mill.');
  const exported = join(one.dir, '..', 'wren-export');
  await one.run('export', 'wren', '--out', exported);
  const two = s.folder('two');
  const imported = await two.run('import', exported);
  assert.equal(imported.imported, true); assert.match(imported.next, /adopt/);
  const st = await two.run('status');
  assert.equal(st.soul.name, 'Wren'); assert.equal(st.paired, false); assert.match(st.next, /adopt/);
  assert.ok((await two.run('memory', 'bees')).matches.length, 'memory on disk, no token');
  const asked = await two.run('adopt', 'wren', '--for', await s.code());
  assert.equal(asked.soulId, wren.id);
  assert.equal((await s.owner('gene', `/v1/account/approvals/${asked.approvalId}/approve`)).status, 200);
  await two.run('approval', 'wait');
  assert.equal((await two.run('status')).paired, true);
  assert.ok((await two.run('memory', 'bees')).matches.length, 'the imported memory stays');
  assert.equal((await two.run('list')).souls[0].state, 'active');
});
