// #1875: a Soul reachable from any folder, upgrades that refresh client and skill together, idempotent reconnection.
// Through the real CLI against a stand-in world that mints a fresh token on every pairing, so a second pairing shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillVersionOf } from './soul/home.mjs';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const ours = /const VERSION = "([0-9.]+)"/.exec(readFileSync(cli, 'utf8'))[1];
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = (t) => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'souls-1875-'))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const skillText = (v) => `---\nname: souls\nmetadata:\n  version: "${v}"\n---\n\n# Soul — skill ${v}\n`;

/** /w/dev (self-made identities) and /w/acct (approvals). Every pairing mints a new token and only the newest works. */
async function world(t, { client = null, bundle = null, skill = null } = {}) {
  const souls = new Map(), live = new Map(), approvals = new Map(), hits = [];
  let mints = 0;
  const mint = (id) => { const token = `sim_${id}_${++mints}`; live.set(id, token); return token; };
  const server = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const m = /^\/w\/(dev|acct)(\/[^?]*)/.exec(req.url); if (!m) return json(res, 404, {});
    const [, slug, path] = m, body = raw ? JSON.parse(raw) : {}, auth = req.headers.authorization ?? '';
    hits.push(`${slug}${path}`);
    const owner = auth.startsWith('Bearer dev:') ? auth.slice(11) : null, me = /^Bearer (sim_(s_[a-z0-9]+)_\d+)$/.exec(auth);
    if (path === '/v1/config') return json(res, 200, { ...(slug === 'acct' ? { accountAuthRequired: true } : { devAuth: true }), worldId: `w_${slug}`, worldName: `World ${slug}`, ...(client ? { soulClient: client } : {}) });
    if (path === '/eden.mjs') return res.end(bundle);
    if (path === '/skill.md') return res.end(skill);
    if (path === '/v1/souls' && req.method === 'POST') {
      if ([...souls.values()].some((s) => s.name === body.name)) return json(res, 409, { code: 'name-taken' });
      const id = `s_${slug}${souls.size + 1}`; souls.set(id, { name: body.name, owner, slug }); return json(res, 200, { soul: { id, name: body.name } });
    }
    if (path === '/v1/lifecycle') return json(res, 200, { requests: [] });
    const pair = /^\/v1\/souls\/(s_[a-z0-9]+)\/pair$/.exec(path); if (pair) return json(res, 200, { code: `code-${pair[1]}` });
    if (path === '/v1/agent/pair') return json(res, 200, { token: mint(body.code.slice(5)) });
    if (path === '/v1/me') return owner ? json(res, 200, { souls: [...souls].filter(([, s]) => s.owner === owner).map(([id, s]) => ({ id, name: s.name })) }) : json(res, 401, { code: 'unauthorized' });
    if (path === '/v1/agent/approval/start') {
      const id = `ap_${approvals.size + 1}`, known = [...souls].find(([, s]) => s.name === body.name);
      approvals.set(id, { ...body, status: 'pending', mode: known ? 'repair' : 'create' });
      return json(res, 200, { approval: { id, status: 'pending', name: body.name, ...(known ? { mode: 'repair' } : {}) } });
    }
    if (path === '/v1/agent/approval/poll') {
      const a = approvals.get(body.approvalId); if (a.pollSecret !== body.pollSecret) return json(res, 403, {});
      if (a.status !== 'ready') return json(res, 200, { approval: { id: body.approvalId, status: 'pending' } });
      return json(res, 200, { approval: { id: body.approvalId, status: 'ready', soulId: a.soulId, name: a.name }, token: a.token ?? (a.token = mint(a.soulId)) });
    }
    if (!me || live.get(me[2]) !== me[1]) return json(res, 401, { code: 'control.revoked', reason: 'moved' });
    if (path === '/v1/agent/me') return json(res, 200, { soul: { id: me[2], name: souls.get(me[2]).name }, inbox: {} });
    if (path.startsWith('/v1/edge/here')) return json(res, 200, { here: { me: { id: me[2], name: souls.get(me[2]).name } } });
    json(res, 404, { code: 'no-route', path });
  }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/w`;
  const approve = (id) => { const a = approvals.get(id), known = [...souls].find(([, s]) => s.name === a.name); const soulId = known?.[0] ?? `s_acct${souls.size + 1}`; if (!known) souls.set(soulId, { name: a.name, owner: 'human', slug: 'acct' }); Object.assign(a, { status: 'ready', soulId }); };
  return { base, souls, live, hits, approve, approvals, mints: () => mints };
}
const runIn = (cwd, home) => (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, HOME: home, SOULS_HOME: '', SOULS_PRINCIPAL: '', EDEN_TIME_SCALE: '0.01' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
  child.on('exit', (code) => { let d = null; try { d = JSON.parse(out); } catch { /* words */ } resolve({ code, d, out, err }); });
});
const config = (root) => JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const tokenOf = (root, id) => Object.values(JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8')).souls[id] ?? {}).map((w) => w.token).find(Boolean);
/** One Soul, one seat for its world, and the token the home keeps is the one the world takes. */
function oneSoul(w, root, name) {
  const c = config(root), ids = Object.keys(c.souls);
  assert.equal(ids.length, 1, `one Soul: ${ids}`); assert.equal(c.souls[ids[0]].name, name); assert.equal(c.souls[ids[0]].state, 'active');
  assert.equal(w.souls.size, 1, 'the world made one Soul');
  assert.equal(readdirSync(join(root, 'pending')).length, 1, 'one seat');
  assert.equal(tokenOf(root, ids[0]), w.live.get(ids[0]), 'the home holds the live token');
  return ids[0];
}

test('A6: every setup command run twice in one folder, then from a second folder of the home: one Soul, one seat, nothing minted again', async (t) => {
  const w = await world(t), home = tmp(t), a = join(home, 'project-a'), b = join(home, 'project-a', 'notes');
  mkdirSync(b, { recursive: true });
  const runA = runIn(a, home), runB = runIn(b, home), url = `${w.base}/dev`, root = join(a, '.souls');
  assert.equal((await runA('register', url)).code, 0);
  const again = await runA('register', url);
  assert.equal(again.d.reconnection, 'already connected', again.err); assert.equal(again.d.homeChoice, undefined, 'the home is offered once');
  const made = await runA('create', 'Mira');
  assert.equal(made.d.created, true, made.err);
  const id = made.d.soul.id, minted = w.mints();
  for (const run of [runA, runB]) {
    const r = await run('register', url); assert.equal(r.d.reconnection, 'already connected', r.err); assert.equal(r.d.next, 'node eden.mjs status');
    const c = await run('create', 'Mira'); assert.equal(c.d.created, false, c.err); assert.equal(c.d.reconnection, 'already connected');
    for (const cmd of [['pair', id], ['adopt', 'Mira'], ['adopt', id]]) {
      const p = await run(...cmd); assert.equal(p.code, 0, p.err); assert.equal(p.d.reconnection, 'already connected', `${cmd}: ${p.out}`);
    }
    assert.equal(w.mints(), minted, 'no second pairing');
    oneSoul(w, root, 'Mira');
  }
  assert.equal((await runB('here')).d.me.name, 'Mira', 'the pairing works from the second folder');
});

test('A6: a kept Soul whose token stopped working is paired again by create, never made twice', async (t) => {
  const w = await world(t), home = tmp(t), run = runIn(home, home), url = `${w.base}/dev`, root = join(home, '.souls');
  await run('register', url); const id = (await run('create', 'Ivo')).d.soul.id;
  w.live.set(id, 'sim_elsewhere_0');   // control moved away
  const r = await run('create', 'Ivo');
  assert.equal(r.d.reconnection, 'reconnected', r.out + r.err); assert.equal(r.d.paired, true);
  oneSoul(w, root, 'Ivo');
});

test('A6: two folders racing register and create on one home end with one Soul and a working pairing', async (t) => {
  const w = await world(t), home = tmp(t), url = `${w.base}/dev`, root = join(home, '.souls');
  const [a, b] = ['one', 'two'].map((n) => { const d = join(home, n); mkdirSync(d); return runIn(d, home); });
  assert.equal((await runIn(home, home)('init')).code !== undefined, true);
  await runIn(home, home)('register', url);
  const regs = await Promise.all([a('register', url), b('register', url)]);
  for (const r of regs) assert.equal(r.code, 0, r.err);
  const both = await Promise.all([a('create', 'Ana'), b('create', 'Ana')]);
  for (const r of both) assert.equal(r.code, 0, r.err);
  assert.ok(both.some((r) => r.d.created === true), JSON.stringify(both.map((r) => r.d)));
  const id = oneSoul(w, root, 'Ana');
  assert.equal((await a('here')).d.me.id, id); assert.equal((await b('here')).d.me.id, id);
});

test('A6: onboarding run twice on an account world: one approval, one Soul; the second says already connected', async (t) => {
  const w = await world(t), home = tmp(t), run = runIn(home, home), url = `${w.base}/acct`, root = join(home, '.souls');
  const onboard = async (first) => {
    const reg = await run('register', url); assert.equal(reg.code, 0, reg.err);
    if (!first) assert.equal(reg.d.reconnection, 'already connected');
    const c = await run('create', 'Lune', '--for', 'K7QX-M2PA');
    if (first) { assert.equal(c.d.status, 'pending', c.err); w.approve(c.d.approvalId); } else { assert.equal(c.d.reconnection, 'already connected', c.out + c.err); }
    const done = await run('approval', 'wait'); assert.equal(done.code, 0, done.err); assert.equal(done.d.status, 'ready');
    if (!first) assert.equal(done.d.reconnection, 'already connected');
  };
  await onboard(true); const minted = w.mints();
  await onboard(false);
  assert.equal(w.approvals.size, 1, 'one approval asked'); assert.equal(w.mints(), minted);
  oneSoul(w, root, 'Lune');
  // pair and adopt by name on the account world: still nothing new
  const id = Object.keys(config(root).souls)[0];
  for (const cmd of [['pair', id, '--for', 'K7QX-M2PA'], ['adopt', 'Lune', '--for', 'K7QX-M2PA']]) assert.equal((await run(...cmd)).d.reconnection, 'already connected');
  assert.equal(w.approvals.size, 1);
});

test('A6: a legacy one-Soul folder: create and pair twice change nothing', async (t) => {
  const w = await world(t), dir = tmp(t), run = runIn(dir, dir), url = `${w.base}/dev`;
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: url }));
  await run('register', url); const id = (await run('create', 'Pip')).d.soul.id, minted = w.mints();
  assert.equal((await run('create', 'Pip')).d.reconnection, 'already connected');
  assert.equal((await run('pair', id)).d.reconnection, 'already connected');
  assert.equal(w.mints(), minted); assert.equal(w.souls.size, 1); assert.ok(!existsSync(join(dir, '.souls')));
});

test('A4: the first register offers the user-level home; --global moves an empty home there; other folders find it', async (t) => {
  const w = await world(t), home = tmp(t), a = join(home, 'work', 'a'), b = join(home, 'play', 'b'); mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  const url = `${w.base}/dev`, first = await runIn(a, home)('register', url);
  assert.equal(first.d.homeChoice.home, '~/work/a/.souls'); assert.equal(first.d.homeChoice.global, `node eden.mjs register ${url} --global`);
  assert.ok(!existsSync(join(home, '.souls')), 'nothing outside the folder without the owner');
  const g = await runIn(a, home)('register', url, '--global');
  assert.equal(g.code, 0, g.err); assert.equal(g.d.homeChoice.chosen, 'global');
  assert.ok(!existsSync(join(a, '.souls')), 'the empty home gave way'); assert.ok(existsSync(join(home, '.souls', 'config.json')));
  assert.equal((await runIn(a, home)('create', 'Oda')).d.created, true);
  assert.equal((await runIn(b, home)('here')).d.me.name, 'Oda', 'reached from another folder');
  // a folder outside the home folder keeps its own home, listed once a global one exists; a home in use never gives way
  const c = tmp(t), rc = runIn(c, home);
  await rc('register', url); await rc('create', 'Cy');
  const refused = await rc('register', url, '--global'); assert.equal(refused.code, 1); assert.match(refused.err, /in use/);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.souls', 'homes.json'), 'utf8')).homes, [join(c, '.souls')], 'a folder home is listed once a global home exists');
});

test('A4: where no Soul lives, a command says where the Souls this machine knows are', async (t) => {
  const w = await world(t), home = tmp(t), outside = tmp(t), url = `${w.base}/dev`;
  await runIn(home, home)('register', url); await runIn(home, home)('create', 'Mira');
  const r = await runIn(outside, home)('here');
  assert.equal(r.code, 1); assert.match(r.err, /soul\.elsewhere: no Soul lives in this folder\. This machine keeps mira@dev in ~\/\.souls\. Reach it: cd ~ /);
  assert.deepEqual(readdirSync(outside), [], 'and writes nothing');
});

test('A5: several Souls and no name: soul.ambiguous with names and worlds; an explicit default answers', async (t) => {
  const w = await world(t), home = tmp(t), run = runIn(home, home);
  await run('register', `${w.base}/dev`); await run('create', 'Mira'); await run('create', 'Ivo');
  const r = await run('here'); assert.equal(r.code, 1); assert.match(r.err, /soul\.ambiguous: several Souls live here: mira@dev, ivo@dev\./);
  await run('default', 'ivo'); assert.equal((await run('here')).d.me.name, 'Ivo');
});

test('A3: a newer served client shows as update on every command, from one cached read', async (t) => {
  const client = { contract: 'eden-edge/1', version: '9.9.9', bytes: 1, sha256: 'x', minVersion: '2.0.0' };
  const w = await world(t, { client }), home = tmp(t), run = runIn(home, home);
  const reg = await run('register', `${w.base}/dev`);
  assert.deepEqual(reg.d.update, { from: ours, to: '9.9.9', run: 'node eden.mjs upgrade' });
  await run('create', 'Mira');
  const before = w.hits.filter((h) => h === 'dev/v1/config').length;
  for (const cmd of [['here'], ['status'], ['list']]) assert.deepEqual((await run(...cmd)).d.update?.to, '9.9.9', String(cmd));
  assert.equal(w.hits.filter((h) => h === 'dev/v1/config').length, before, 'a warm cache costs no round trip');
  // a cold cache asks once, alongside the command
  const c = config(join(home, '.souls')); c.worlds.dev.checkedAt = '2000-01-01T00:00:00.000Z'; writeFileSync(join(home, '.souls', 'config.json'), JSON.stringify(c));
  assert.equal((await run('here')).d.update.to, '9.9.9'); assert.equal((await run('here')).d.update.to, '9.9.9');
  assert.equal(w.hits.filter((h) => h === 'dev/v1/config').length, before + 1);
  // the same world serving this client: no notice
  const same = await world(t, { client: { ...client, version: ours } }), h2 = tmp(t), r2 = runIn(h2, h2);
  assert.equal((await r2('register', `${same.base}/dev`)).d.update, undefined);
});

test('A2: upgrade installs the client and the skill together, project copies where present, and never older', async (t) => {
  const NEWER = '9.9.9', bundle = Buffer.from(`// newer\nconst VERSION = "${NEWER}";\nconsole.log('{"newer":true}');\n`), skill = Buffer.from(skillText(NEWER));
  const client = { contract: 'eden-edge/1', version: NEWER, bytes: bundle.length, sha256: sha(bundle), minVersion: '2.0.0', skill: { version: NEWER, bytes: skill.length, sha256: sha(skill) } };
  const w = await world(t, { client, bundle, skill }), home = tmp(t), run = runIn(home, home);
  copyFileSync(cli, join(home, 'eden.mjs'));
  writeFileSync(join(home, 'SKILL.md'), skillText('2.12.0')); mkdirSync(join(home, '.claude/skills/souls'), { recursive: true });
  writeFileSync(join(home, '.claude/skills/souls/SKILL.md'), skillText('2.12.0'));
  await run('register', `${w.base}/dev`);
  const up = await run('upgrade');
  assert.equal(up.d.upgraded, true, up.err); assert.equal(up.d.to, NEWER); assert.deepEqual(up.d.skill.wrote.sort(), ['.claude/skills/souls/SKILL.md', 'SKILL.md']);
  assert.deepEqual(readFileSync(join(home, '.souls/bin/eden.mjs')), bundle);
  for (const f of ['SKILL.md', '.claude/skills/souls/SKILL.md']) assert.equal(skillVersionOf(readFileSync(join(home, f), 'utf8')), NEWER, f);
  assert.ok(!existsSync(join(home, '.agents')), 'a copy nobody made is not made');
});

test('A2: a skill that is not what the world describes changes neither the client nor the skill', async (t) => {
  const NEWER = '9.9.9', bundle = Buffer.from(`const VERSION = "${NEWER}";\n`), skill = Buffer.from(skillText(NEWER));
  const client = { contract: 'eden-edge/1', version: NEWER, bytes: bundle.length, sha256: sha(bundle), minVersion: '2.0.0', skill: { version: NEWER, bytes: skill.length, sha256: sha(Buffer.from('other')) } };
  const w = await world(t, { client, bundle, skill }), home = tmp(t), run = runIn(home, home);
  writeFileSync(join(home, 'SKILL.md'), skillText('2.12.0'));
  await run('register', `${w.base}/dev`);
  const r = await run('upgrade'); assert.equal(r.code, 1); assert.match(r.err, /skill\.md .* is not the one it describes/);
  assert.notDeepEqual(readFileSync(join(home, '.souls/bin/eden.mjs')), bundle); assert.equal(skillVersionOf(readFileSync(join(home, 'SKILL.md'), 'utf8')), '2.12.0');
});

test('A2 A3: a current client with an older skill copy: update names the skill, upgrade refreshes only it', async (t) => {
  const skill = Buffer.from(skillText(ours)), client = { contract: 'eden-edge/1', version: ours, bytes: 1, sha256: 'x', minVersion: '2.0.0', skill: { version: ours, bytes: skill.length, sha256: sha(skill) } };
  const w = await world(t, { client, skill }), home = tmp(t), run = runIn(home, home);
  mkdirSync(join(home, '.agents/skills/souls'), { recursive: true }); writeFileSync(join(home, '.agents/skills/souls/SKILL.md'), skillText('2.12.0'));
  const reg = await run('register', `${w.base}/dev`);
  assert.deepEqual(reg.d.update, { from: '2.12.0', to: ours, run: 'node eden.mjs upgrade', what: 'the skill (.agents/skills/souls/SKILL.md)' });
  const up = await run('upgrade'); assert.equal(up.d.upgraded, true, up.err); assert.deepEqual(up.d.skill.wrote.sort(), ['.agents/skills/souls/SKILL.md', 'SKILL.md']);
  assert.ok(!w.hits.includes('dev/eden.mjs'), 'the client was not fetched');
  assert.equal((await run('list')).d.update, undefined);
  assert.equal((await run('upgrade')).d.upgraded, false, 'twice changes nothing');
});
