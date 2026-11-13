// #2244: the client logs in to an account, keeps several apart and lists what an account holds. Through the real CLI
// against stand-in worlds that keep the account-grant/1 wire contract (#2242). The fake proves the client keeps to the
// contract, not that the server does (#2246 runs this login against the real server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const tmp = (t) => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'souls-2244-'))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const hex = (n) => randomBytes(n).toString('hex');
// Every token the stand-in hands out carries this mark, so a leak is found whatever shape it takes.
const MARK = 'zq9acct';

/** /w/acct: an account world. Login requests, grants and their tokens, the account's Souls, and Soul approvals. */
async function world(t, { accountLogin = true } = {}) {
  const requests = new Map(), byKey = new Map(), grants = new Map(), souls = new Map(), approvals = new Map(), live = new Map(), hits = [];
  // #2246: the agent that holds each Soul now, and why each older Soul token stopped working.
  const holder = new Map(), ended = new Map();
  let base = '';
  const shown = ({ pollSecret, grant, ...q }) => q;
  const server = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const m = /^\/w\/acct(\/[^?]*)/.exec(req.url); if (!m) return json(res, 404, {});
    const path = m[1], body = raw ? JSON.parse(raw) : {}, auth = req.headers.authorization ?? null, at = { id: 'w_acct', name: 'World acct', url: `${base}/acct` };
    hits.push({ method: req.method, path, auth });
    if (path === '/v1/config') return json(res, 200, { accountAuthRequired: true, ...(accountLogin ? { accountLogin: true } : {}), worldId: 'w_acct', worldName: 'World acct' });
    if (path === '/v1/agent/account/login' && req.method === 'POST') {
      const good = typeof body.agentLabel === 'string' && body.agentLabel.length <= 120 && /^dev_[0-9a-f]{32}$/.test(body.device?.id ?? '') && body.device.name?.length >= 1 && body.device.name.length <= 60
        && body.idempotencyKey?.length >= 16 && /^[A-Za-z0-9_-]{43}$/.test(body.pollSecret ?? '');
      if (!good) return json(res, 400, { ok: false, code: 'invalid', message: 'The login request does not fit account-grant/1.' });
      let q = byKey.get(body.idempotencyKey);
      if (q && q.pollSecret !== body.pollSecret) return json(res, 409, { ok: false, code: 'idempotency-key-reused', message: 'That key belongs to another request.' });
      if (!q) { q = { id: `aq_${hex(16)}`, kind: 'login', status: 'pending', agentLabel: body.agentLabel, device: { name: body.device.name }, soul: null, confirm: 'K7QX', createdAt: 0, expiresAt: 0, inWindow: !!body.for, pollSecret: body.pollSecret }; requests.set(q.id, q); byKey.set(body.idempotencyKey, q); }
      return json(res, 200, { request: shown(q), world: at, approvalURL: `${base}/acct/#approve/${q.id}`, delivery: q.inWindow ? 'window' : 'link', intervalSeconds: 3 });
    }
    if (path === '/v1/agent/account/requests/poll') {
      const q = requests.get(body.requestId);
      if (!q || q.pollSecret !== body.pollSecret) return json(res, 404, { ok: false, code: 'not-found', message: 'No such request.' });
      const g = q.status === 'ready' ? grants.get(q.grant) : null;
      return json(res, 200, { request: shown(q), world: at, ...(g?.live ? { account: { id: g.accountId }, grant: { id: g.id, createdAt: 0 }, token: g.token } : {}) });
    }
    if (path.startsWith('/v1/agent/account')) {
      const token = /^Bearer (sacct_\S+)$/.exec(auth ?? '')?.[1], g = [...grants.values()].find((x) => x.token === token);
      if (!g) return json(res, 401, { ok: false, code: 'account.unknown', message: 'This world never issued this account token.' });
      if (!g.live) return json(res, 401, { ok: false, code: 'account.revoked', message: 'This account login has ended.' });
      if (path === '/v1/agent/account/logout' && req.method === 'POST') { g.live = false; return json(res, 200, { ok: true }); }
      if (path === '/v1/agent/account') return json(res, 200, { account: { id: g.accountId }, grant: { id: g.id, agentLabel: 'eden', device: g.device, createdAt: 0 }, world: at, maxSouls: 5,
        souls: [...souls].filter(([, s]) => s.account === g.accountId).map(([id, s]) => ({ id, name: s.name, control: { held: live.has(id), state: live.has(id) ? 'connected' : 'disconnected', since: null }, agent: holder.has(id) ? { label: holder.get(id).label, since: 0 } : null })) });
      const one = /^\/v1\/agent\/account\/souls\/([^/]+)\/(pair|revoke|retire)$/.exec(path);
      if (one && req.method === 'POST') {
        const [, id, what] = one, s = souls.get(id);
        if (!s) return json(res, 404, { ok: false, code: 'soul-not-found', message: `No Soul ${id} lives in this world.` });
        if (s.account !== g.accountId) return json(res, 403, { ok: false, code: 'forbidden', message: 'Not your Soul.' });
        if (what === 'pair') {
          let a = [...approvals].find(([, x]) => x.idempotencyKey === body.idempotencyKey);
          if (!a) { a = [`ap_${approvals.size + 1}`, { ...body, soulId: id, name: s.name, status: 'ready', agentLabel: `${body.agentLabel} on ${g.device.name}` }]; approvals.set(...a); }
          return json(res, 200, { approval: { id: a[0], status: 'ready', soulId: id, name: s.name, mode: 'repair' }, world: at, delivery: 'account', intervalSeconds: 3 });
        }
        if (what === 'revoke') { if (holder.has(id)) ended.set(holder.get(id).token, 'revoked'); holder.delete(id); live.delete(id); return json(res, 200, { ok: true, soulId: id }); }
        const q = { id: `aq_${hex(16)}`, kind: 'retire', status: 'pending', agentLabel: 'eden', device: g.device, soul: { id, name: s.name }, confirm: 'R3TX', createdAt: 0, expiresAt: 0, inWindow: true, pollSecret: body.pollSecret, by: g.accountId };
        requests.set(q.id, q);
        return json(res, 200, { request: shown(q), world: at, approvalURL: `${base}/acct/#approve/${q.id}`, delivery: 'window', intervalSeconds: 3 });
      }
    }
    if (path === '/v1/agent/approval/start') { const id = `ap_${approvals.size + 1}`; approvals.set(id, { ...body, status: 'pending' }); return json(res, 200, { approval: { id, status: 'pending', name: body.name } }); }
    if (path === '/v1/agent/approval/poll') {
      const a = approvals.get(body.approvalId); if (a.pollSecret !== body.pollSecret) return json(res, 403, {});
      if (a.status !== 'ready') return json(res, 200, { approval: { id: body.approvalId, status: 'pending' } });
      if (!a.token) {   // a new Soul token replaces the one before it: the last device to ask wins
        a.token = `sim_${a.soulId}_${MARK}${hex(8)}`;
        if (holder.has(a.soulId)) { ended.set(holder.get(a.soulId).token, 'replaced'); live.delete(a.soulId); }
        holder.set(a.soulId, { token: a.token, label: a.agentLabel?.includes(' on ') ? a.agentLabel : 'eden' });
      }
      return json(res, 200, { approval: { id: body.approvalId, status: 'ready', soulId: a.soulId, name: a.name }, token: a.token });
    }
    const me = /^Bearer (sim_(s_[a-z0-9]+)_\S+)$/.exec(auth ?? '');
    if (path === '/v1/agent/me' && me && ended.has(me[1])) return json(res, 401, { ok: false, code: 'control.revoked', reason: ended.get(me[1]), message: 'This Soul token no longer controls the Soul.' });
    if (path === '/v1/agent/me' && me && souls.has(me[2])) { live.set(me[2], me[1]); return json(res, 200, { soul: { id: me[2], name: souls.get(me[2]).name }, inbox: {} }); }
    json(res, 404, { ok: false, code: 'no-route', message: path });
  }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = () => { server.closeAllConnections(); server.close(); };
  t.after(close);
  base = `http://127.0.0.1:${server.address().port}/w`;
  /** The fake person approves a login as their account. */
  const approve = (requestId, accountId) => { const q = requests.get(requestId), id = `ag_${hex(16)}`; grants.set(id, { id, accountId, device: q.device, token: `sacct_${MARK}${randomBytes(27).toString('base64url')}`, live: true }); Object.assign(q, { status: 'ready', grant: id }); };
  const approveSoul = (approvalId, account) => { const a = approvals.get(approvalId), soulId = `s_acct${souls.size + 1}`; souls.set(soulId, { name: a.name, account }); Object.assign(a, { status: 'ready', soulId }); };
  const tokenOf = (accountId) => [...grants.values()].filter((g) => g.accountId === accountId).at(-1)?.token;
  const revoke = (accountId) => { for (const g of grants.values()) if (g.accountId === accountId) g.live = false; };
  const count = (method, path) => hits.filter((h) => h.method === method && h.path === path).length;
  /** The fake person answers a retire request: ready, or cancelled (and who ended it, #2258). */
  const decide = (requestId, status, ended) => { Object.assign(requests.get(requestId), { status }, ended ? { ended } : {}); };
  return { base, url: `${base}/acct`, requests, grants, souls, approvals, holder, hits, approve, approveSoul, decide, tokenOf, revoke, count, close,
    secrets: () => [...[...grants.values()].map((g) => g.token), ...[...requests.values()].map((q) => q.pollSecret), ...[...approvals.values()].flatMap((a) => [a.pollSecret, a.token])].filter(Boolean) };
}
const runIn = (cwd, home, printed = []) => (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, HOME: home, SOULS_HOME: '', SOULS_PRINCIPAL: '', EDEN_TIME_SCALE: '0.01' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
  child.on('exit', (code) => { printed.push({ args: args.join(' '), text: out + err }); let d = null; try { d = JSON.parse(out); } catch { /* words */ } resolve({ code, d, out, err }); });
});
const read = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const tree = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? tree(join(dir, e.name)) : e.isSocket() ? [] : [join(dir, e.name)]);
/** login, then the fake person approves it as `accountId`, then login wait. */
async function logIn(w, run, accountId, ...args) {
  const r = await run('login', ...args); assert.equal(r.code, 0, r.out + r.err); assert.equal(r.d.login, 'pending', r.out);
  w.approve(r.d.requestId, accountId);
  const done = await run('login', 'wait'); assert.equal(done.d?.login, 'connected', done.out + done.err);
  return done.d;
}

test('A1, A4, A5: login once, run again, list the account, and nothing prints a token or a poll secret', async (t) => {
  const w = await world(t), home = tmp(t), dir = join(home, 'project'), printed = [];
  mkdirSync(dir);
  const run = runIn(dir, home, printed), root = join(dir, '.souls');
  // A1: a login with a URL registers the world first and makes the home, and says what the person needs.
  const a = await run('login', w.url, '--device', 'studio laptop');
  assert.equal(a.code, 0, a.err); assert.ok(existsSync(join(root, 'config.json')), 'the home is made');
  assert.equal(a.d.login, 'pending'); assert.equal(a.d.approvalURL, `${w.url}/#approve/${a.d.requestId}`);
  assert.equal(a.d.confirm, 'K7QX'); assert.equal(a.d.delivery, 'link'); assert.match(a.d.next, /node eden\.mjs login wait$/);
  const sent = w.requests.get(a.d.requestId);
  assert.equal(sent.device.name, 'studio laptop');
  // A second login while one waits is the same request.
  const b = await run('login');
  assert.equal(b.d.requestId, a.d.requestId, b.out + b.err); assert.equal(w.requests.size, 1);
  const seat = read(join(root, 'pending', 'acct'), 'state.json');
  assert.equal(seat.pendingLogin.requestId, a.d.requestId); assert.equal(seat.pendingLogin.input.pollSecret, undefined, 'the poll secret is not in the seat');
  assert.equal(read(root, 'credentials.json').logins.acct.pollSecret, sent.pollSecret);
  w.approve(a.d.requestId, 'acct_1');
  const done = await run('login', 'wait');
  assert.equal(done.d.login, 'connected', done.out + done.err); assert.equal(done.d.alias, 'me'); assert.equal(done.d.account, 'acct_1');
  const creds = read(root, 'credentials.json'), cfg = read(root, 'config.json');
  assert.equal(statSync(join(root, 'credentials.json')).mode & 0o777, 0o600);
  assert.equal(creds.accounts.me.token, w.tokenOf('acct_1')); assert.equal(creds.logins.acct, undefined, 'the poll secret goes once the login is done');
  assert.deepEqual(Object.keys(cfg.accounts.me).sort(), ['accountId', 'at', 'grantId', 'origin', 'world']);
  assert.equal(cfg.accounts.me.origin, new URL(w.url).origin); assert.equal(cfg.activeAccount[new URL(w.url).origin], 'me');
  assert.match(cfg.device.id, /^dev_[0-9a-f]{32}$/); assert.equal(cfg.device.name, 'studio laptop');
  assert.equal(read(join(root, 'pending', 'acct'), 'state.json').pendingLogin, undefined);
  // Run again: each says already connected after one account read, and starts nothing.
  for (const args of [['login'], ['login', 'wait'], ['login', w.url]]) {
    const reads = w.count('GET', '/v1/agent/account'), starts = w.count('POST', '/v1/agent/account/login');
    const r = await run(...args);
    assert.equal(r.d?.login, 'already connected', `${args}: ${r.out}${r.err}`); assert.equal(r.d.alias, 'me');
    assert.equal(w.count('GET', '/v1/agent/account'), reads + 1, `${args}: one account read`); assert.equal(w.count('POST', '/v1/agent/account/login'), starts, `${args}: nothing started`);
  }
  // A4: a Soul paired here, and one the account holds elsewhere.
  const made = await run('create', 'Mira'); assert.equal(made.d.status, 'pending', made.out + made.err);
  w.approveSoul(made.d.approvalId, 'acct_1');
  assert.equal((await run('approval', 'wait')).d.paired, true);
  assert.equal((await run('status')).code, 0);
  w.souls.set('s_acct9', { name: 'Ivo', account: 'acct_1' }); w.souls.set('s_acct8', { name: 'Not mine', account: 'acct_2' });
  const listed = await run('list', '--account');
  assert.equal(listed.code, 0, listed.err);
  assert.deepEqual(listed.d.account, { alias: 'me', id: 'acct_1' });
  assert.deepEqual(listed.d.souls.map((s) => [s.name, s.id, s.control.held, s.agent?.label ?? null, s.here]), [['Mira', 's_acct1', true, 'eden', true], ['Ivo', 's_acct9', false, null, false]]);
  assert.deepEqual((await run('list')).d.souls.map((s) => s.name), ['Mira'], 'list with no flag is as before');
  assert.deepEqual((await run('doctor')).d.orphanCredentials, [], 'a login is not an orphan credential');
  // A5: the guide a fresh chat reads names the commands, and help account is one screen.
  const guide = readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), head = guide.slice(0, guide.indexOf('not in your own memory.'));
  for (const said of ['`node eden.mjs accounts`', '`node eden.mjs login`', '`node eden.mjs help account`']) assert.ok(head.includes(said), said);
  const topic = await run('help', 'account');
  assert.ok(topic.out.split('\n').length <= 24, 'one screen'); for (const said of ['login wait', 'accounts switch', 'logout', '--as']) assert.ok(topic.out.includes(said), said);
  // Nothing printed holds a secret, and no file but credentials.json does.
  const secrets = w.secrets(), leaked = (text) => secrets.some((s) => text.includes(s)) || text.includes(MARK);
  assert.ok(secrets.length >= 4);
  assert.deepEqual(printed.filter((p) => leaked(p.text)).map((p) => p.args), [], 'no command prints a token or a poll secret');
  assert.deepEqual(tree(dir).filter((p) => !p.endsWith('/.souls/credentials.json') && !p.endsWith('/bin/eden.mjs') && leaked(readFileSync(p, 'latin1'))).map((p) => p.slice(dir.length)), [], 'only credentials.json holds a secret');
});

test('A2, A3: several accounts on one origin, switch, --as, a login reusing its alias, and logout however the world answers', async (t) => {
  const w = await world(t), other = await world(t), home = tmp(t), run = runIn(home, home), root = join(home, '.souls'), origin = new URL(w.url).origin;
  assert.equal((await logIn(w, run, 'acct_1', w.url)).alias, 'me');
  const work = await logIn(w, run, 'acct_2', '--as', 'work');
  assert.equal(work.alias, 'work');
  const hits = w.hits.length, listed = (await run('accounts')).d.accounts;
  assert.equal(w.hits.length, hits, 'accounts makes no world call');
  assert.deepEqual(listed.map((a) => [a.alias, a.origin, a.accountId, a.active, a.souls]), [['me', origin, 'acct_1', false, []], ['work', origin, 'acct_2', true, []]]);
  assert.equal((await run('accounts', 'switch', 'me')).d.active, 'me');
  assert.equal(read(root, 'config.json').activeAccount[origin], 'me');
  const unknown = await run('list', '--account', '--as', 'nobody');
  assert.equal(unknown.code, 1); assert.match(unknown.err, /nobody[^]*me, work/);
  assert.equal((await run('list', '--account', '--as', 'work')).d.account.id, 'acct_2', '--as picks one for one command');
  assert.equal(read(root, 'config.json').activeAccount[origin], 'me', 'and leaves the active one');
  // A dead login is dropped; a login that turns out to be an account the home has keeps that account's alias.
  w.revoke('acct_1');
  const again = await logIn(w, run, 'acct_2');
  assert.equal(again.alias, 'work');
  assert.deepEqual(Object.keys(read(root, 'credentials.json').accounts), ['work']);
  assert.equal((await logIn(w, run, 'acct_1', '--as', 'me')).alias, 'me');
  // A3: logout ends it in the world and here; another login of that origin becomes active; the Souls stay connected.
  const out = await run('logout');
  assert.equal(out.code, 0, out.err); assert.equal(out.d.loggedOut, 'me'); assert.equal(out.d.world, 'ended'); assert.equal(out.d.active, 'work');
  assert.match(out.d.souls, /stay connected/);
  assert.equal([...w.grants.values()].find((g) => g.accountId === 'acct_1' && g.token === w.tokenOf('acct_1')).live, false);
  assert.deepEqual(Object.keys(read(root, 'credentials.json').accounts), ['work']);
  // A token already dead still logs out here.
  w.revoke('acct_2');
  const dead = await run('logout', 'work');
  assert.equal(dead.d.world, 'already ended'); assert.equal(dead.d.active, null); assert.deepEqual(read(root, 'credentials.json').accounts, {});
  // A world that does not answer still logs out here.
  assert.equal((await logIn(other, run, 'acct_7', other.url)).alias, 'me');
  other.close();
  const gone = await run('logout', 'me');
  assert.equal(gone.code, 0, gone.err); assert.match(gone.d.world, /did not answer/); assert.deepEqual(read(root, 'config.json').accounts, {});
});

test('A4, A5: an account token never goes to another origin; no login says so; an old world is too old for login', async (t) => {
  const w = await world(t), b = await world(t), old = await world(t, { accountLogin: false }), home = tmp(t), run = runIn(home, home);
  await logIn(w, run, 'acct_1', w.url);
  assert.equal((await run('register', b.url)).code, 0);
  const none = await run('list', '--account', '@acct-2');
  assert.equal(none.code, 0, none.err); assert.equal(none.d.account, null); assert.equal(none.d.next, 'node eden.mjs login');
  const refused = await run('list', '--account', '@acct-2', '--as', 'me');
  assert.equal(refused.code, 1); assert.match(refused.err, /account\.origin/);
  assert.deepEqual(b.hits.filter((h) => h.auth), [], 'the other origin never saw an Authorization header');
  assert.equal((await run('list', '--account', '@acct')).d.account.id, 'acct_1');
  const tooOld = await run('login', old.url);
  assert.equal(tooOld.code, 1); assert.match(tooOld.err, /too old for account login/);
  assert.equal(old.count('POST', '/v1/agent/account/login'), 0);
});

// #2246: with a login a Soul moves between homes with no code; the home it left says where it went and unpairs it.
/** create, the fake person approves it for `account`, approval wait: the Soul lives in this home. */
async function make(w, run, name, account) {
  const asked = await run('create', name); assert.equal(asked.d?.status, 'pending', asked.out + asked.err);
  w.approveSoul(asked.d.approvalId, account);
  const done = await run('approval', 'wait'); assert.equal(done.d?.paired, true, done.out + done.err);
  return done.d.soul;
}

test('#2246 A1, A2: adopt moves a Soul with no code; the home it left unpairs it, says where it runs, and its other Soul answers', async (t) => {
  const w = await world(t), printed = [], homes = tmp(t), dir = (n) => { const d = join(homes, n); mkdirSync(d); return d; };
  const one = runIn(dir('one'), homes, printed), two = runIn(dir('two'), homes, printed), three = runIn(dir('three'), homes, printed), rootOne = join(homes, 'one', '.souls'), rootTwo = join(homes, 'two', '.souls');
  assert.equal((await one('register', w.url)).code, 0);
  const mira = await make(w, one, 'Mira', 'acct_1'), ivo = await make(w, one, 'Ivo', 'acct_1');
  await logIn(w, one, 'acct_1');
  assert.match((await one('status')).err, /soul\.ambiguous/, 'two Souls live in home one');
  // A1: home two logs in once and adopts by name: no code, no approval by the person, one pair route.
  await logIn(w, two, 'acct_1', w.url, '--device', 'desk');
  const moved = await two('adopt', 'Mira');
  assert.equal(moved.code, 0, moved.out + moved.err); assert.equal(moved.d.status, 'ready'); assert.deepEqual(moved.d.soul, mira);
  assert.equal(w.count('POST', `/v1/agent/account/souls/${mira.id}/pair`), 1);
  assert.equal(read(rootTwo, 'config.json').souls[mira.id].account, 'acct_1', 'tagged with the account');
  assert.equal(read(rootTwo, 'config.json').souls[mira.id].state, 'active');
  for (const args of [['adopt', 'Mira'], ['pair', mira.id], ['adopt', mira.id]]) {
    const again = await two(...args);
    assert.equal(again.d?.reconnection, 'already connected', `${args}: ${again.out}${again.err}`);
  }
  assert.equal(w.count('POST', `/v1/agent/account/souls/${mira.id}/pair`), 1, 'run again, nothing is paired');
  // A2: home one hears it moved, where it runs now, and the way back; Mira is unpaired there with her memory, her token gone.
  const left = await one('mira', 'status');
  assert.equal(left.code, 0, left.err); assert.equal(left.d.paired, false); assert.equal(left.d.control, 'replaced'); assert.match(left.d.why, /^Control of Mira moved to another device \(.* on desk\)/);
  assert.match(left.d.runs, / on desk$/); assert.equal(left.d.next, 'node eden.mjs adopt Mira');
  assert.equal(read(rootOne, 'config.json').souls[mira.id].state, 'unpaired');
  assert.deepEqual(Object.values(read(rootOne, 'credentials.json').souls[mira.id] ?? {}).filter((x) => x.token), [], 'the dead token is removed');
  assert.ok(existsSync(join(rootOne, 'souls', mira.id)), 'her memory folder stays');
  const other = await one('status');
  assert.equal(other.code, 0, other.err); assert.equal(other.d.soul.id, ivo.id, 'a bare command now speaks for the other Soul');
  // Without a login nothing changes, and the next step names login. revoke and retire say they need one.
  assert.equal((await three('register', w.url)).code, 0);
  const byName = await three('adopt', 'Mira');
  assert.equal(byName.code, 1); assert.match(byName.err, /--for <CODE>.*node eden\.mjs login/);
  const coded = await three('pair', mira.id, '--for', 'K7QX-M2PA');
  assert.equal(coded.d?.status, 'pending', coded.out + coded.err); assert.match(coded.d.next, /approval wait.*node eden\.mjs login$/);
  for (const cmd of ['revoke', 'retire']) { const no = await three(cmd, mira.id); assert.equal(no.code, 1); assert.match(no.err, /needs a login.*node eden\.mjs login/, cmd); }
  assert.equal(w.count('POST', `/v1/agent/account/souls/${mira.id}/pair`), 1);
  const secrets = w.secrets();
  assert.deepEqual(printed.filter((p) => secrets.some((s) => p.text.includes(s)) || p.text.includes(MARK)).map((p) => p.args), [], 'no command prints a token or a poll secret');
});

test('#2246 A3, A4: two accounts in one home; a tagged Soul uses its own login; --as the other is refused; a cancelled retire changes nothing', async (t) => {
  const w = await world(t), home = tmp(t), run = runIn(home, home), root = join(home, '.souls');
  await logIn(w, run, 'acct_1', w.url);
  await logIn(w, run, 'acct_2', '--as', 'work');   // newest: the active one
  w.souls.set('s_kai', { name: 'Kai', account: 'acct_1' }); w.souls.set('s_lu', { name: 'Lu', account: 'acct_2' });
  const token = (alias) => read(root, 'credentials.json').accounts[alias].token, sentWith = (path) => w.hits.filter((h) => h.path === path).map((h) => h.auth);
  // Untagged: the active login, or --as. The world refuses another account's Soul and the client says so.
  const wrong = await run('adopt', 's_kai');
  assert.equal(wrong.code, 1); assert.match(wrong.err, /not that account's Soul \(login work\)/);
  const kai = await run('adopt', 's_kai', '--as', 'me');
  assert.equal(kai.d?.status, 'ready', kai.out + kai.err);
  assert.equal(read(root, 'config.json').souls.s_kai.account, 'acct_1');
  // Tagged: its own login whatever --as says.
  const off = await run('revoke', 'Kai', '--as', 'work');
  assert.equal(off.code, 0, off.err); assert.equal(off.d.revoked, true); assert.equal(off.d.account, 'me'); assert.match(off.d.here, /unpaired/);
  assert.deepEqual(sentWith('/v1/agent/account/souls/s_kai/revoke'), [`Bearer ${token('me')}`]);
  assert.equal(read(root, 'config.json').souls.s_kai.state, 'unpaired'); assert.deepEqual(Object.values(read(root, 'credentials.json').souls.s_kai ?? {}).filter((x) => x.token), []);
  const theirs = await run('revoke', 's_lu', '--as', 'me');
  assert.equal(theirs.code, 1); assert.match(theirs.err, /not that account's Soul \(login me\)/);
  assert.equal((await run('revoke', 's_lu')).d?.revoked, true, 'the active login is work');
  // retire: asks, prints the link and the code; a cancel changes nothing here.
  const asked = await run('retire', 'Kai', '--as', 'work');
  assert.equal(asked.code, 0, asked.err); assert.equal(asked.d.retire, 'pending'); assert.equal(asked.d.confirm, 'R3TX');
  assert.equal(asked.d.approvalURL, `${w.url}/#approve/${asked.d.requestId}`); assert.match(asked.d.next, /node eden\.mjs retire wait$/);
  assert.equal(w.requests.get(asked.d.requestId).by, 'acct_1', 'asked with the tagged login');
  assert.equal(read(join(root, 'pending', 'acct'), 'state.json').pendingRetire.input.pollSecret, undefined, 'the poll secret is not in the seat');
  w.decide(asked.d.requestId, 'cancelled');
  const waited = await run('retire', 'wait');
  assert.equal(waited.d?.retire, 'cancelled', waited.out + waited.err); assert.equal(waited.d.retired, false);
  assert.equal(read(root, 'config.json').souls.s_kai.state, 'unpaired', 'nothing changed here');
  assert.deepEqual(Object.keys(read(root, 'credentials.json').logins), [], 'the retire poll secret is gone');
});

test('#2258 A3: login wait and retire wait keep polling while the request is open, and stop cleanly when refused or replaced', async (t) => {
  const w = await world(t), home = tmp(t), run = runIn(home, home), root = join(home, '.souls'), seat = () => read(join(root, 'pending', 'acct'), 'state.json');
  const polls = () => w.count('POST', '/v1/agent/account/requests/poll');
  const until = async (ok) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(ok(), 'timed out waiting in the test'); };
  // login wait has no deadline: it keeps asking while the person has not answered, then reports their refusal
  const asked = await run('login', w.url); assert.equal(asked.d.login, 'pending', asked.out + asked.err);
  const waiting = run('login', 'wait');
  await until(() => polls() >= 5);
  w.decide(asked.d.requestId, 'cancelled', 'refused');
  const refused = await waiting;
  assert.equal(refused.code, 0, refused.err); assert.equal(refused.d.login, 'refused'); assert.match(refused.d.why, /refused/); assert.match(refused.d.next, /node eden\.mjs login$/);
  assert.equal(seat().pendingLogin, undefined, 'a refused login is forgotten');
  // retire wait: replaced by this agent's newer ask, the old wait stops and leaves the newer one waiting
  await logIn(w, run, 'acct_1');
  w.souls.set('s_kai', { name: 'Kai', account: 'acct_1' });
  const first = await run('retire', 's_kai'); assert.equal(first.d?.retire, 'pending', first.out + first.err);
  const before = polls(), old = run('retire', 'wait');
  await until(() => polls() >= before + 3);
  const state = seat(); state.pendingRetire = { ...state.pendingRetire, requestId: 'aq_' + '0'.repeat(32) }; writeFileSync(join(root, 'pending', 'acct', 'state.json'), JSON.stringify(state));
  w.decide(first.d.requestId, 'cancelled', 'replaced');
  const replaced = await old;
  assert.equal(replaced.code, 0, replaced.err); assert.equal(replaced.d.retire, 'replaced'); assert.equal(replaced.d.retired, false); assert.match(replaced.d.why, /newer request/);
  assert.equal(seat().pendingRetire?.requestId, 'aq_' + '0'.repeat(32), 'the newer request stays in the seat');
});
