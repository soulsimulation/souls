// #1133 A5: nothing secret leaves credentials.json. Two Souls in two worlds and a god seat in one home, with memory,
// through the real CLIs against a stand-in world: every command a person or an agent runs prints no token, identity or
// poll secret, no file outside credentials.json holds one, and the skill and guides name that file as never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const eden = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url)), god = fileURLToPath(new URL('../god-skill/eden-god.mjs', import.meta.url));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
// Every secret the stand-in hands out carries this mark, so a leak is found whatever shape it takes.
const MARK = 'zq9secret';

async function worlds(t) {
  const souls = new Map(), approvals = new Map();
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const m = /^\/w\/([abc])(\/[^?]*)/.exec(req.url); if (!m) return json(res, 404, {});
      const [, slug, path] = m, body = raw ? JSON.parse(raw) : {}, auth = req.headers.authorization ?? '', me = new RegExp(`^Bearer sim_(s_[a-z0-9]+)_${MARK}`).exec(auth)?.[1];
      if (path === '/v1/config') return json(res, 200, slug === 'c' ? { accountAuthRequired: true, worldId: 'w_c', worldName: 'World c' } : { devAuth: true, worldId: `w_${slug}`, worldName: `World ${slug}` });
      if (path === '/v1/god/mint') return auth ? json(res, 200, { token: `god_${slug}_${MARK}`, world: slug }) : json(res, 401, {});
      if (path === '/v1/god/status') return auth === `Bearer god_${slug}_${MARK}` ? json(res, 200, { you: 'god', world: slug, entities: 0, seq: 1, versions: {} }) : json(res, 401, { code: 'unauthorized' });
      if (path === '/v1/souls' && req.method === 'POST') { const id = `s_${slug}${souls.size + 1}`; souls.set(id, { name: body.name, owner: auth.slice(11) }); return json(res, 200, { soul: { id, name: body.name } }); }
      const pair = /^\/v1\/souls\/(s_[a-z0-9]+)\/pair$/.exec(path); if (pair) return json(res, 200, { code: `code-${pair[1]}` });
      if (path === '/v1/agent/pair') return json(res, 200, { token: `sim_${body.code.slice(5)}_${MARK}` });
      if (path === '/v1/me') return json(res, 200, { souls: [...souls].filter(([id, s]) => id.startsWith(`s_${slug}`) && auth === `Bearer dev:${s.owner}`).map(([id, s]) => ({ id, name: s.name })) });
      if (path === '/v1/agent/approval/start') { const id = `ap_${approvals.size + 1}`; approvals.set(id, body); return json(res, 200, { approval: { id, status: 'pending', name: body.name } }); }
      if (path === '/v1/agent/approval/poll') return json(res, 200, { approval: { id: body.approvalId, status: 'pending' } });
      if (!me || !souls.has(me)) return json(res, 401, { code: 'control.unknown' });
      if (path === '/v1/agent/me') return json(res, 200, { soul: { id: me, name: souls.get(me).name }, inbox: {} });
      if (path === '/v1/edge/self/link') return json(res, 200, { link: { state: 'connected' }, now: null });
      if (path === '/v1/edge/here') return json(res, 200, { here: { tick: 10, clock: '08:00', now: '· world day 2', me: { soulId: me, name: souls.get(me).name, place: 'square', placePath: ['the square'], posture: 'standing' }, near: [] } });
      if (path === '/v1/edge/wait') return setTimeout(() => json(res, 200, { cursor: 'c_0', events: [] }), 100);
      if (path.startsWith('/v1/edge/inbox/listen')) return setTimeout(() => json(res, 200, { inbox: { connected: true }, backlog: [] }), 100);
      json(res, 404, { code: 'no-route', path });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}/w`, approvals };
}
const runner = (cwd, cli, printed) => (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, HOME: cwd, SOULS_HOME: '', SOULS_PRINCIPAL: '', EDEN_GOD_SEAT: '', EDEN_GOD_HELPER: '', EDEN_GOD_WARM: '0', EDEN_GOD_WIRE: '0', EDEN_TIME_SCALE: '0.01' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
  child.on('exit', (code) => { printed.push({ args: args.join(' '), text: out + err }); let d = null; try { d = JSON.parse(out); } catch { /* words */ } resolve({ code, d, out, err }); });
});
const tree = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? tree(join(dir, e.name)) : e.isSocket() ? [] : [join(dir, e.name)]);

test('#1133 A5: two Souls and a god seat with memory: no command prints a secret and only credentials.json holds one', async (t) => {
  const f = await worlds(t), dir = realpathSync(mkdtempSync(join(tmpdir(), 'souls-secrets-')));
  t.after(() => { for (const p of ['souls', 'gods']) if (existsSync(join(dir, '.souls', p))) chmodSync(join(dir, '.souls', p), 0o700); rmSync(dir, { recursive: true, force: true }); });
  const printed = [], soul = runner(dir, eden, printed), godCli = runner(dir, god, printed);

  await soul('register', `${f.base}/a`); assert.equal((await soul('create', 'Mira')).d?.created, true);
  await soul('register', `${f.base}/b`); assert.equal((await soul('create', 'Ivo')).d?.created, true);
  assert.equal((await godCli('register', `${f.base}/a`, `dev:owner-${MARK}`)).code, 0);
  assert.equal((await godCli('mint')).code, 0);
  // A Soul waiting on an account world's approval holds a poll secret too.
  await soul('register', `${f.base}/c`); assert.equal((await soul('create', 'Wren')).d?.status, 'pending');
  const creds = JSON.parse(readFileSync(join(dir, '.souls/credentials.json'), 'utf8'));
  assert.equal(statSync(join(dir, '.souls/credentials.json')).mode & 0o777, 0o600);
  const secrets = [...JSON.stringify(creds).matchAll(/"(?:token|identity|pollSecret|homeToken)":"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(secrets.filter((s) => s.includes(MARK)).length >= 3, 'two Soul tokens and a god token');
  assert.ok(secrets.some((s) => /^agent-[0-9a-f]{24}$/.test(s)), 'a dev identity');
  assert.ok([...f.approvals.values()].some((a) => a.pollSecret && secrets.includes(a.pollSecret)), 'the poll secret is kept, and only here');

  for (const name of ['mira', 'ivo']) { await soul(name, 'here'); await soul(name, 'remember', '--place', 'square', 'Good light.'); await soul(name, 'memory', 'light'); await soul(name, 'status'); }
  assert.equal((await soul('mira', 'serve')).d?.serving, true);
  await soul('mira', 'pending'); await soul('mira', 'serve', '--status'); await soul('mira', 'serve', '--stop');
  for (const args of [['list'], ['doctor'], ['guide'], ['help'], ['version'], ['nonsense-command'], ['export', 'mira', '--out', 'away-mira'], ['export', 'ivo', '--out', 'away-ivo']]) await soul(...args);
  for (const args of [['status'], ['doctor', '--local', '--json'], ['help']]) await godCli(...args);
  // A token the world no longer knows: the refusal names no secret either.
  creds.souls.s_a1.a.token = `sim_s_a9_${MARK}gone`; writeFileSync(join(dir, '.souls/credentials.json'), JSON.stringify(creds), { mode: 0o600 });
  await soul('mira', 'here');

  const leaked = (text) => secrets.filter((s) => text.includes(s)).length + (text.includes(MARK) ? 1 : 0) + (/agent-[0-9a-f]{24}/.test(text) ? 1 : 0);
  assert.ok(leaked(readFileSync(join(dir, '.souls/credentials.json'), 'utf8')) >= 3, 'the check finds what credentials.json holds');
  assert.ok(printed.length >= 30);
  assert.deepEqual(printed.filter((p) => leaked(p.text)).map((p) => p.args), [], 'no command prints a secret');
  const files = tree(dir).filter((p) => !p.endsWith('/.souls/credentials.json') && !p.endsWith('/bin/eden.mjs'));
  assert.ok(files.some((p) => p.includes('/memory/')) && files.some((p) => p.includes('away-mira/memory/')), 'memory was written and exported');
  assert.deepEqual(files.filter((p) => leaked(readFileSync(p, 'latin1'))).map((p) => p.slice(dir.length)), [], 'no file but credentials.json holds a secret');

  // The skill, the instructions, the god skill and the guide a new chat reads each name the one file never to read.
  const never = /[Nn]ever (?:read|print)[^.]*`\.souls\/credentials\.json`|`\.souls\/credentials\.json`[^.]*never read/;
  for (const doc of [eden.replace('eden.mjs', 'skill.md'), eden.replace('eden.mjs', 'instructions.md'), god.replace('eden-god.mjs', 'SKILL.md'), join(dir, 'CLAUDE.md'), join(dir, 'AGENTS.md')]) assert.match(readFileSync(doc, 'utf8').replace(/\s+/g, ' '), never, doc.slice(doc.lastIndexOf('/') + 1));
});
