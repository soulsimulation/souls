// node --test tools/world-launcher/soul-cli-proxy.test.mjs — the client in an environment that reaches the internet only
// through HTTPS_PROXY (hosted agent sandboxes): register, the catalog and the event stream go through the proxy, NO_PROXY
// sends a host direct, a proxy the client cannot get through is said once by its code and not retried, and a read-only
// project skill copy is a note, not an error. The world is https://world.test, which never resolves: only the proxy's
// tunnel reaches it. Each case runs on the built-in CONNECT tunnel (EDEN_PROXY_TUNNEL=1) and, where the runtime has it,
// on Node's own proxyEnv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_PROXY, bypassed, netFetch, proxyFor } from './soul/net.mjs';
import { createHome, openHome } from './soul/home.mjs';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const MODES = [['tunnel', '1'], ...(NATIVE_PROXY ? [['native proxyEnv', '']] : [])];
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY'];
const tmp = (t, tag) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `soul-proxy-${tag}-`))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const json = (res, status, v) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

/** Self-signed certificates for world.test and for an https proxy at localhost, made once; `file` trusts both. */
let CERT = null;
function cert() {
  if (CERT) return CERT;
  const dir = mkdtempSync(join(tmpdir(), 'soul-proxy-cert-'));
  const make = (name) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`), '-days', '1', '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) };
  };
  const world = make('world.test'), proxy = make('localhost');
  writeFileSync(join(dir, 'trust.pem'), Buffer.concat([world.cert, proxy.cert]));
  return (CERT = { dir, file: join(dir, 'trust.pem'), ...world, proxy });
}

/** world.test over TLS: config, here, catalog, live and an event stream that stays open. */
async function world(t) {
  const seen = [], c = cert();
  const server = createHttps({ key: c.key, cert: c.cert }, (req, res) => {
    const p = new URL(req.url, 'https://world.test').pathname.replace(/^\/w\/proxied/, '');
    seen.push(p);
    if (p === '/v1/config') return json(res, 200, { accountAuthRequired: true, worldId: 'w_proxied', worldName: 'Proxied' });
    if (p === '/v1/edge/here') return json(res, 200, { place: 'green' });
    if (p === '/v1/edge/catalog') return json(res, 200, { contract: 'soul-catalog/1', worldId: 'w_proxied', placeVerbs: [], anywhere: [], places: [{ id: 'p_town', name: 'Town', kind: 'district', parent: null, at: [0, 0] }], things: [], acts: [], counts: {} });
    if (p === '/v1/edge/live') return json(res, 200, { contract: 'soul-live/1', tick: 1, souls: [{ id: 's_ada', name: 'Ada', at: [0, 0], place: 'p_town' }], speech: [] });
    // a redirect to another origin, and to this one; /echo says what it was sent
    if (p === '/redir-cross') { res.writeHead(307, { location: 'https://other.test/w/proxied/echo' }); res.end(); return undefined; }
    if (p === '/redir-same') { res.writeHead(307, { location: '/w/proxied/echo' }); res.end(); return undefined; }
    if (p === '/echo') return json(res, 200, { host: req.headers.host, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
    if (p === '/v1/edge/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: hello\ndata: {"cursor":"c_0"}\n\n'); return undefined; }
    return json(res, 404, { error: { code: 'nope', message: p } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, port: server.address().port };
}

/** A CONNECT proxy that sends world.test (and any of `hosts`) to the local world and records each tunnel it was asked for.
 *  `refuse` answers the CONNECT with that status; `hangUp` closes the connection without answering. */
async function proxy(t, worldPort, { refuse = 0, hangUp = false, hosts = ['world.test:443'] } = {}) {
  const tunnels = [];
  const server = createHttp((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, socket) => {
    tunnels.push({ target: req.url, auth: req.headers['proxy-authorization'] ?? null });
    if (hangUp) { socket.end(); return; }
    if (refuse) { socket.end(`HTTP/1.1 ${refuse} Forbidden\r\n\r\n`); return; }
    if (!hosts.includes(req.url)) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const up = connect(worldPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(socket); socket.pipe(up); });
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { tunnels, port: server.address().port };
}

const env = (extra) => {
  const e = { ...process.env, EDEN_NO_NOW: '1', EDEN_TIME_SCALE: '0.01', SOULS_HOME: '', SOULS_PRINCIPAL: '', NODE_EXTRA_CA_CERTS: cert().file };
  for (const k of PROXY_VARS) delete e[k];
  return { ...e, ...extra };
};
const runIn = (cwd, extra) => (...args) => new Promise((resolve) => {
  const t0 = performance.now(), child = spawn(process.execPath, [cli, ...args], { cwd, env: env({ HOME: cwd, ...extra }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
  child.on('exit', (code) => { let d = null; try { d = JSON.parse(out); } catch { /* words */ } resolve({ code, d, out, err, ms: performance.now() - t0 }); });
});
const BASIC = `Basic ${Buffer.from('agent:s3cret pass').toString('base64')}`;
/** A local proxy's URL with synthetic credentials in its userinfo. */
const withAuth = (port, password) => Object.assign(new URL(`http://127.0.0.1:${port}`), { username: 'agent', password }).href;

test('NO_PROXY: *, a host, .domain and domain, a port, either case; localhost and 127.0.0.1 are always direct', () => {
  const p = 'http://proxy.example:3128';
  assert.equal(proxyFor('https://world.test/w/x', { HTTPS_PROXY: p })?.host, 'proxy.example:3128');
  assert.equal(proxyFor('https://world.test/w/x', { https_proxy: 'proxy.example:8080' })?.href, 'http://proxy.example:8080/', 'a bare host:port is an http proxy');
  assert.equal(proxyFor('https://world.test/w/x', { HTTP_PROXY: p }), null, 'https takes HTTPS_PROXY');
  assert.equal(proxyFor('http://world.test/w/x', { http_proxy: p })?.host, 'proxy.example:3128');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(proxyFor(`https://${host}:8443/w/x`, { HTTPS_PROXY: p }), null, host);
  for (const no of ['*', 'world.test', '.test', 'test', 'other.example, world.test', 'world.test:443', 'WORLD.TEST']) assert.equal(bypassed('https://world.test/w/x', { NO_PROXY: no }), true, no);
  for (const no of ['', 'orld.test', 'world.test:8443', 'sub.world.test']) assert.equal(bypassed('https://world.test/w/x', { no_proxy: no }), false, no);
  assert.equal(bypassed('https://a.world.test/w/x', { no_proxy: '.world.test' }), true);
});

for (const [mode, tunnel] of MODES) {
  test(`${mode}: register and a catalog read reach world.test only through the proxy, with its credentials`, { timeout: 60_000 }, async (t) => {
    const w = await world(t), px = await proxy(t, w.port);
    const extra = { HTTPS_PROXY: withAuth(px.port, 's3cret pass'), EDEN_PROXY_TUNNEL: tunnel };
    const dir = tmp(t, 'reg'), reg = await runIn(dir, extra)('register', 'https://world.test/w/proxied');
    assert.equal(reg.code, 0, reg.err); assert.equal(reg.d.registered, true, reg.out);
    assert.ok(w.seen.includes('/v1/config'), w.seen.join(' '));
    // a Soul's folder: look reads the catalog and the live picture with fetch
    const soul = tmp(t, 'look');
    writeFileSync(join(soul, '.eden-agent.json'), JSON.stringify({ world: 'https://world.test/w/proxied', soul: 's_ada', token: 'sim_s_synthetic' }), { mode: 0o600 });
    const look = await runIn(soul, extra)('look');
    assert.equal(look.code, 0, look.err);
    for (const p of ['/v1/edge/catalog', '/v1/edge/live']) assert.ok(w.seen.includes(p), `${p}: ${w.seen.join(' ')}`);
    assert.ok(px.tunnels.length > 0); assert.deepEqual([...new Set(px.tunnels.map((x) => x.target))], ['world.test:443']);
    assert.ok(px.tunnels.every((x) => x.auth === BASIC), 'proxy basic auth from the URL');
    for (const out of [reg.out, reg.err, look.out, look.err]) assert.doesNotMatch(out, /s3cret|agent:|127\.0\.0\.1/);
  });

  test(`${mode}: the event stream comes through the proxy as it arrives, and keep-alive reuses one tunnel`, { timeout: 30_000 }, async (t) => {
    const w = await world(t), px = await proxy(t, w.port), saved = Object.fromEntries(PROXY_VARS.concat('EDEN_PROXY_TUNNEL', 'NODE_TLS_REJECT_UNAUTHORIZED').map((k) => [k, process.env[k]]));
    for (const k of PROXY_VARS) delete process.env[k];
    Object.assign(process.env, { HTTPS_PROXY: `http://127.0.0.1:${px.port}`, EDEN_PROXY_TUNNEL: tunnel, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    const ac = new AbortController(), r = await netFetch('https://world.test/w/proxied/v1/edge/events', { headers: { accept: 'text/event-stream' }, signal: ac.signal });
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'text/event-stream');
    const first = await r.body.getReader().read();
    assert.match(Buffer.from(first.value).toString('utf8'), /event: hello/, 'a frame arrives while the stream is still open');
    ac.abort();
    for (let i = 0; i < 2; i++) assert.equal((await (await netFetch('https://world.test/w/proxied/v1/edge/here')).json()).place, 'green');
    assert.equal(px.tunnels.length, 2, 'one tunnel for the held stream, one kept alive for both reads');
  });

  test(`${mode}: NO_PROXY sends world.test direct, past the proxy`, { timeout: 60_000 }, async (t) => {
    const w = await world(t), px = await proxy(t, w.port);
    const r = await runIn(tmp(t, 'noproxy'), { HTTPS_PROXY: `http://127.0.0.1:${px.port}`, NO_PROXY: 'example.org,.test', EDEN_PROXY_TUNNEL: tunnel })('register', 'https://world.test/w/proxied');
    assert.equal(r.code, 75, r.out + r.err); assert.match(r.err, /ENOTFOUND|EAI_AGAIN/, 'it looked world.test up itself');
    assert.deepEqual(px.tunnels, [], 'the proxy was never asked');
  });

  test(`${mode}: a proxy that cannot be reached, or refuses the tunnel, is said once by its code, without its address, and not retried`, { timeout: 60_000 }, async (t) => {
    const closed = createHttp(); await new Promise((r) => closed.listen(0, '127.0.0.1', r)); const port = closed.address().port; await new Promise((r) => closed.close(r));
    const w = await world(t), refusing = await proxy(t, w.port, { refuse: 403 }), hanging = await proxy(t, w.port, { hangUp: true });
    for (const [why, at, code] of [['nothing listening', port, /ECONNREFUSED/], ['403 to CONNECT', refusing.port, /ERR_PROXY_TUNNEL|403/], ['closed without an answer', hanging.port, /ERR_PROXY_TUNNEL|ECONNRESET/]]) {
      const r = await runIn(tmp(t, 'down'), { HTTPS_PROXY: withAuth(at, 's3cret'), EDEN_PROXY_TUNNEL: tunnel })('register', 'https://world.test/w/proxied');
      const said = r.out + r.err;
      assert.equal(r.code, 75, `${why}: ${said}`);
      assert.match(said, /this environment sends its traffic through a proxy \(HTTPS_PROXY\), and the client could not reach the world through it/, why);
      assert.match(said, code, why);
      assert.equal(said.match(/through a proxy/g).length, 1, `${why}: said once`);
      assert.doesNotMatch(said, /trying again|try 2 of/, `${why}: not retried`);
      assert.doesNotMatch(said, new RegExp(`s3cret|agent:|127\\.0\\.0\\.1|:${at}\\b`), `${why}: no proxy address or credentials`);
      assert.ok(r.ms < 10_000, `${why}: answered in ${Math.round(r.ms)} ms`);
    }
    assert.equal(refusing.tunnels.length, 1, 'the refusing proxy was asked once');
    assert.equal(hanging.tunnels.length, 1, 'the proxy that hung up was asked once');
  });

  test(`${mode}: a redirect to another origin carries no Authorization or Cookie; one to the same origin does`, { timeout: 30_000 }, async (t) => {
    const w = await world(t), px = await proxy(t, w.port, { hosts: ['world.test:443', 'other.test:443'] }), saved = Object.fromEntries(PROXY_VARS.concat('EDEN_PROXY_TUNNEL', 'NODE_TLS_REJECT_UNAUTHORIZED').map((k) => [k, process.env[k]]));
    for (const k of PROXY_VARS) delete process.env[k];
    Object.assign(process.env, { HTTPS_PROXY: `http://127.0.0.1:${px.port}`, EDEN_PROXY_TUNNEL: tunnel, NODE_TLS_REJECT_UNAUTHORIZED: '0' });   // other.test is served with world.test's certificate
    t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    const headers = { authorization: 'Bearer sim_s_synthetic', cookie: 'a=b' };
    const cross = await (await netFetch('https://world.test/w/proxied/redir-cross', { headers })).json();
    assert.deepEqual(cross, { host: 'other.test', authorization: null, cookie: null });
    const same = await (await netFetch('https://world.test/w/proxied/redir-same', { headers })).json();
    assert.deepEqual(same, { host: 'world.test', authorization: 'Bearer sim_s_synthetic', cookie: 'a=b' });
    await assert.rejects(netFetch('https://world.test/w/proxied/redir-same', { headers, redirect: 'error' }), /fetch failed/);
  });

  test(`${mode}: an http world through an https proxy: the proxy's certificate is checked against the proxy's name`, { timeout: 60_000 }, async (t) => {
    const asked = [], c = cert();
    const px = createHttps({ key: c.proxy.key, cert: c.proxy.cert }, (req, res) => {
      asked.push(req.url);
      if (req.url === 'http://world.test/w/proxied/v1/config') return json(res, 200, { accountAuthRequired: true, worldId: 'w_proxied', worldName: 'Proxied' });
      return json(res, 404, {});
    });
    await new Promise((r) => px.listen(0, '127.0.0.1', r));
    t.after(() => { px.closeAllConnections(); px.close(); });
    const r = await runIn(tmp(t, 'tlsproxy'), { HTTP_PROXY: `https://localhost:${px.address().port}`, EDEN_PROXY_TUNNEL: tunnel })('register', 'http://world.test/w/proxied');
    assert.equal(r.code, 0, r.out + r.err); assert.equal(r.d.registered, true);
    assert.deepEqual(asked, ['http://world.test/w/proxied/v1/config'], 'asked in absolute form, through the proxy');
  });
}

test('a project skill copy in a read-only folder is a one-line note; SKILL.md beside it is written and no upgrade asks for it again', { skip: process.getuid?.() === 0 && 'root writes anywhere' }, (t) => {
  const dir = tmp(t, 'skill'), h = openHome(createHome(join(dir, '.souls'))), old = '---\nname: souls\nmetadata:\n  version: "2.1.0"\n---\n';
  writeFileSync(join(dir, 'SKILL.md'), old);
  for (const copy of ['.claude/skills/souls', '.agents/skills/souls']) { mkdirSync(join(dir, copy), { recursive: true }); writeFileSync(join(dir, copy, 'SKILL.md'), old); }
  chmodSync(join(dir, '.agents/skills/souls/SKILL.md'), 0o444); chmodSync(join(dir, '.agents/skills/souls'), 0o555);
  let out;
  try { out = h.installSkill(Buffer.from(old.replace('2.1.0', '9.9.9')), '9.9.9', [dir]); } finally { chmodSync(join(dir, '.agents/skills/souls'), 0o755); }
  assert.deepEqual(out.wrote.sort(), ['.claude/skills/souls/SKILL.md', 'SKILL.md']);
  assert.equal(out.notes.length, 1); assert.doesNotMatch(out.notes[0], /\n/);
  assert.match(out.notes[0], /^\.agents\/skills\/souls\/SKILL\.md was not updated \((EACCES|EROFS|EPERM)\); SKILL\.md in this folder is the current skill\.$/);
  assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /9\.9\.9/);
  assert.deepEqual(h.skillBehind('9.9.9', [dir]), [], 'the read-only copy does not ask for another upgrade');
});
