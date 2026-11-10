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
  const listener = getRequestListener(app.fetch), me: { seen?: string[] } = {};
  const server = createServer((req, res) => { if (req.url!.endsWith('/approval/souls')) me.seen?.push(req.url!); req.url = req.url!.replace(/^\/w\/test/, '') || '/'; listener(req, res); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const root = mkdtempSync(join(tmpdir(), 'cli-recovery-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); f.host.stop(); f.db.close(); });
  const world = `http://127.0.0.1:${(server.address() as { port: number }).port}/w/test`;
  const owner = (name: string, path: string) => app.request(path, { method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json', authorization: `Bearer owner:${name}` }, body: '{}' });
  const code = async (name = 'gene') => (await (await owner(name, '/v1/account/window-code')).json() as { code: string }).code;
  const folder = (name: string) => {
    const dir = join(root, name); mkdirSync(dir, { recursive: true }); copyFileSync(CLI, join(dir, 'eden.mjs'));
    const raw = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => execFile(process.execPath, ['eden.mjs', ...args], { cwd: dir, env: { ...process.env, HOME: dir } }, (e, out, err) => resolve({ code: e ? (e.code as number) ?? 1 : 0, out, err })));
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
  return Object.assign(me, { f, world, owner, code, folder, make });
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
  // and the home it left says so, with the way back, which works
  const left = await first.run('status');
  assert.equal(left.paired, false); assert.match(left.next, new RegExp(`adopt ${wren.id} --for`));
  const back = await first.run('adopt', wren.id, '--for', await s.code());
  assert.equal((await s.owner('gene', `/v1/account/approvals/${back.approvalId}/approve`)).status, 200);
  assert.equal((await first.run('approval', 'wait')).soul.id, wren.id);
  assert.equal((await first.run('status')).paired, true); assert.equal((await fresh.run('status')).paired, false);
});

for (const [name, typed] of [['Мира', ['мира', ' Мира']], ['Zoë', ['ZOË', 'Zoe\u0308']]] as const) test(`${name}, however it is typed, is that Soul: case, spacing or composed form never makes a second`, async t => {
  const s = await site(t), soul = await s.make(s.folder('one'), name);
  for (const [i, asked] of typed.entries()) {
    const fresh = s.folder(`fresh-${i}`); await fresh.run('register', s.world);
    assert.equal((await fresh.run('create', asked, '--for', await s.code())).soulId, soul.id, JSON.stringify(asked));
  }
  const adopter = s.folder('adopter'); await adopter.run('register', s.world);
  assert.equal((await adopter.run('adopt', typed[0], '--for', await s.code())).soulId, soul.id, 'adopt folds the same way');
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
  assert.match(wrong.worlds[0].note, /unknown here or has expired/);
});

test('a world that can\'t list the Souls just now says so; it doesn\'t blame the code', async t => {
  const s = await site(t), home = s.folder('one'); await s.make(home, 'Wren');
  const code = await s.code();
  let out = await home.run('doctor', '--for', code);
  for (let i = 0; i < 6; i++) out = await home.run('doctor', '--for', code);
  const note = out.worlds.map((w: { note?: string }) => w.note).join(' ');
  assert.match(note, /could not list/); assert.doesNotMatch(note, /unknown here or has expired/);
});

test('a retried create stays the request it was, before and after its approval', async t => {
  const s = await site(t), first = s.folder('one');
  await first.run('register', s.world);
  const code = await s.code(), asked = await first.run('create', 'Wren', '--for', code);
  assert.equal((await s.owner('gene', `/v1/account/approvals/${asked.approvalId}/approve`)).status, 200);
  const again = await first.run('create', 'Wren', '--for', code);
  assert.equal(again.approvalId, asked.approvalId, 'approved and not yet collected: the same request');
  const wren = (await first.run('approval', 'wait')).soul;
  const fresh = s.folder('two'); await fresh.run('register', s.world);
  const reconnect = await fresh.run('create', 'Wren', '--for', code), twice = await fresh.run('create', 'Wren', '--for', code);
  assert.equal(twice.approvalId, reconnect.approvalId); assert.equal(twice.soulId, wren.id);
});

test('adopt keeps to the world it is in, and a window code goes only to its own world', async t => {
  const a = await site(t), b = await site(t), h = a.folder('one'), wrenA = await a.make(h, 'Wren');
  const wrenB = await b.make(b.folder('there'), 'Wren');
  await h.run('register', b.world);
  const code = await b.code();
  const asked = await h.run('adopt', 'Wren', '--for', code);
  assert.equal(asked.soulId, wrenB.id, "the world this home is in, not the Wren it holds safely elsewhere"); assert.notEqual(wrenA.id, wrenB.id);
  assert.equal((await h.run('wren@test', 'status')).soul.id, wrenA.id, 'that Wren is untouched');
  const seen: string[] = []; a.seen = seen;
  await h.run('doctor', '--for', code);
  assert.deepEqual(seen, [], "the other world never saw this world's code");
  // The home's Wren loses control. An id still goes to its own world; a bare name asks which, and sends the code nowhere.
  rmSync(join(h.dir, '.souls/credentials.json'));
  const byId = await h.run('adopt', wrenA.id, '--for', await a.code());
  assert.equal(byId.soulId, wrenA.id, 'by id, from a seat in the other world');
  await h.run('register', b.world);
  const which = await h.raw('adopt', 'Wren', '--for', await b.code());
  assert.notEqual(which.code, 0); assert.match(which.err, /@test adopt/);
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

test('a config.json moved aside comes back from the Souls on disk', async t => {
  const s = await site(t), h = s.folder('one'), wren = await s.make(h, 'Wren');
  await h.run('remember', '--self', 'I keep bees by the mill.');
  const cfg = join(h.dir, '.souls/config.json');
  writeFileSync(cfg, '{oops');
  const corrupt = await h.raw('status');
  assert.notEqual(corrupt.code, 0); assert.match(corrupt.err, /move it aside/);
  renameSync(cfg, `${cfg}.broken`);
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
  const doctor = await two.run('doctor');
  assert.deepEqual(doctor.unpaired.map((u: { id: string }) => u.id), [wren.id]); assert.equal(doctor.healthy, false);
  const asked = await two.run('adopt', 'wren', '--for', await s.code());
  assert.equal(asked.soulId, wren.id);
  assert.equal((await s.owner('gene', `/v1/account/approvals/${asked.approvalId}/approve`)).status, 200);
  await two.run('approval', 'wait');
  assert.equal((await two.run('status')).paired, true);
  assert.ok((await two.run('memory', 'bees')).matches.length, 'the imported memory stays');
  assert.equal((await two.run('list')).souls[0].state, 'active');
  const home = JSON.parse(readFileSync(join(two.dir, '.souls/config.json'), 'utf8'));
  assert.deepEqual(home.trustedOrigins ?? [], [], 'a url out of an imported file earns no trust');
  await two.run('register');
  assert.deepEqual(JSON.parse(readFileSync(join(two.dir, '.souls/config.json'), 'utf8')).trustedOrigins ?? [], [], 'nor does a bare register of the url it left behind');
});
