// soul.game behind the CDN (#2513). A1/A2: the real site file and trust snippet in a real Caddy in front of a real
// launcher (needs a `caddy` binary on PATH or in $CADDY; skipped, and so unproved, without one). A3: check-soul-game.mjs
// against a loopback stand-in of the whole stack, which passes, and fails for its own reason on each of the six points
// when that point is broken. No network beyond loopback.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { checkSoulGame, staticRanges, FORGED, POINTS } from './deploy/caddy/check-soul-game.mjs';
import { testPort } from '../lib/test-port.ts';

const CADDY_DIR = new URL('./deploy/caddy/', import.meta.url).pathname;
const SITE = readFileSync(join(CADDY_DIR, 'soul-game.caddy'), 'utf8'), TRUST = readFileSync(join(CADDY_DIR, 'cdn-trust.snippet'), 'utf8');
const CADDY = process.env.CADDY ?? 'caddy';
const hasCaddy = spawnSync(CADDY, ['version'], { encoding: 'utf8' }).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'soul-game-caddy-'));
after(() => rmSync(dir, { recursive: true, force: true }));
// Caddy keeps its storage under HOME / XDG_DATA_HOME: point both into the test's own directory
const caddyEnv = { ...process.env, HOME: dir, XDG_DATA_HOME: join(dir, 'xdg-data'), XDG_CONFIG_HOME: join(dir, 'xdg-config') };

/** The production layout: the Caddyfile's global options import the snippet, then every site file. */
function layout(name, { site, trust, global = 'admin off' }) {
  const d = join(dir, name); mkdirSync(join(d, 'sites'), { recursive: true });
  writeFileSync(join(d, 'cdn-trust.snippet'), trust);
  writeFileSync(join(d, 'sites', 'soul-game.caddy'), site);
  writeFileSync(join(d, 'Caddyfile'), `{\n\t${global}\n\timport cdn-trust.snippet\n}\nimport sites/*.caddy\n`);
  return join(d, 'Caddyfile');
}

test('A1: the site file and the trust snippet pass caddy validate in the production layout', { skip: !hasCaddy && 'no caddy binary (set $CADDY)' }, () => {
  assert.ok(staticRanges(TRUST).length >= 20, 'the snippet lists the published ranges');
  assert.match(SITE, /^https:\/\/soul\.game \{$/m);
  const file = layout('validate', { site: SITE.replaceAll('@@PRODUCTION_PORT@@', '4600'), trust: TRUST, global: 'admin 127.0.0.1:2019' });
  const r = spawnSync(CADDY, ['validate', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8', env: caddyEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr + r.stdout, /Valid configuration/);
  // and every range arrives: Caddy silently drops ranges written in a { } block, which validates as trusting nobody
  const json = JSON.parse(spawnSync(CADDY, ['adapt', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8', env: caddyEnv }).stdout);
  for (const srv of Object.values(json.apps.http.servers)) {
    assert.deepEqual(srv.trusted_proxies?.ranges, staticRanges(TRUST));
    assert.deepEqual(srv.client_ip_headers, ['CF-Connecting-IP']);
  }
});

test('A2: through Caddy, a trusted peer is keyed to CF-Connecting-IP whatever X-Forwarded-For says; anyone else to the peer', { skip: !hasCaddy && 'no caddy binary (set $CADDY)' }, async () => {
  const base = await testPort(3), lp = base, cp = base + 1;
  for (const d of ['web', 'templates']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Souls</title>');
  const L = await openLauncher({ port: lp, range: [base + 2, base + 2], dataDir: join(dir, 'data'), webDir: join(dir, 'web'), templatesDir: join(dir, 'templates'), publicOrigin: 'http://soul.test', eager: 0, prewarm: false, log: () => {} });
  // the site file as it is, on loopback: plain http on a test port, listening on 127.0.0.1 and ::1; the snippet with one
  // more trusted range, 127.0.0.1 (the stand-in CDN peer), so ::1 is an untrusted peer reaching the origin directly
  const site = SITE.replaceAll('@@PRODUCTION_PORT@@', String(lp)).replace(/^https:\/\/soul\.game \{$/m, `http://:${cp} {\n\tbind 127.0.0.1 [::1]`);
  const trust = TRUST.replace('trusted_proxies static ', 'trusted_proxies static 127.0.0.1/32 ');
  const caddy = spawn(CADDY, ['run', '--config', layout('run', { site, trust }), '--adapter', 'caddyfile'], { env: caddyEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; caddy.stderr.on('data', (d) => { err += d; });
  try {
    const who = async (host, headers = {}) => (await (await fetch(`http://${host}:${cp}/__sim/whoami`, { headers })).json()).address;
    for (let i = 0; ; i++) { try { await who('127.0.0.1'); break; } catch (e) { if (i > 100 || caddy.exitCode !== null) throw Error(`caddy did not start: ${err.slice(-2000)}`); await new Promise((r) => setTimeout(r, 100)); } }
    const VISITOR = '198.51.100.23', FORGED_CF = '192.0.2.99';
    assert.equal(await who('127.0.0.1', { 'cf-connecting-ip': VISITOR, 'x-forwarded-for': `${FORGED}, 10.1.2.3` }), VISITOR, 'trusted peer: the CDN header wins over a forged X-Forwarded-For');
    assert.equal(await who('127.0.0.1', { 'cf-connecting-ip': '2001:db8::7', 'x-forwarded-for': FORGED }), '2001:db8::7', 'an IPv6 visitor');
    assert.equal(await who('127.0.0.1', { 'x-forwarded-for': FORGED }), '127.0.0.1', 'trusted peer without the CDN header: the peer, never empty, never forged');
    assert.equal(await who('127.0.0.1', { 'cf-connecting-ip': 'not-an-address', 'x-forwarded-for': FORGED }), '127.0.0.1', 'an invalid CDN header: the peer');
    assert.equal(await who('[::1]', { 'cf-connecting-ip': FORGED_CF, 'x-forwarded-for': FORGED }), '::1', 'untrusted peer: both headers ignored, the peer');
    // the launcher keys one entry: the header Caddy sends has exactly one
    const r = await checkSoulGame({ origin: `http://127.0.0.1:${cp}`, points: ['forged'] });
    assert.equal(r.pass, true, r.problems.join('\n'));
  } finally { caddy.kill(); await L.close(); }
});

// --- A3: the check against a stand-in stack --------------------------------------------------------------------------
const VISITOR = '198.51.100.5';
/** A minimal WebSocket server side: the RFC 6455 handshake and one unmasked text frame. */
function wsAccept(req, socket, message) {
  const key = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
  if (message) { const b = Buffer.from(message); socket.write(Buffer.concat([Buffer.from([0x81, b.length]), b])); }
  socket.on('error', () => {}); socket.on('data', () => {});
}
/** The CDN, Caddy and the launcher in one: answers what each point asks; `broken` breaks one. */
function stack(broken = null) {
  const ranges = staticRanges(TRUST), v4 = ranges.filter((x) => !x.includes(':')), v6 = ranges.filter((x) => x.includes(':'));
  const s = createServer((req, res) => {
    const path = req.url.split('?')[0], j = (st, b, h = {}) => res.writeHead(st, { 'content-type': 'application/json', ...h }).end(JSON.stringify(b));
    if (path === '/cdn-cgi/trace') return res.end(`fl=1\nh=soul.game\nip=${VISITOR}\nts=1\n`);
    if (path === '/__sim/whoami') {
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      return j(200, { address: broken === 'address' ? '192.0.2.10' : broken === 'forged' && xff ? xff : VISITOR });   // 'address': keyed on the CDN's own address
    }
    if (path === '/__sim/healthz') return broken === 'agent' ? res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }).end('<title>Just a moment...</title>') : j(200, { ok: true });
    if (path === '/w/eden/v1/edge/act' && req.method === 'POST') return j(401, { ok: false, code: 'auth.required' });
    if (path === '/w/eden/v1/edge/events') {
      if (req.headers.authorization !== 'Bearer sim_check') return j(401, { ok: false });
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n');
      // 'events': buffered on the way, so the first event comes late
      const t = setTimeout(() => res.write('event: hello\ndata: {}\n\n'), broken === 'events' ? 2000 : 10); req.on('close', () => clearTimeout(t)); return;
    }
    if (path === '/ips-v4') return res.end(`${v4.join('\n')}\n${broken === 'ranges' ? '203.0.113.0/24\n' : ''}`);
    if (path === '/ips-v6') return res.end(`${v6.join('\n')}\n`);
    res.writeHead(404).end();
  });
  const sockets = new Set();
  s.on('upgrade', (req, socket) => {
    sockets.add(socket);
    if (!req.url.startsWith('/w/eden/ws?hello=')) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    wsAccept(req, socket, broken === 'viewer' ? '{"t":"error","code":"proto"}' : '{"t":"welcome","proto":1}');
  });
  return new Promise((yes) => s.listen(0, '127.0.0.1', () => { const o = `http://127.0.0.1:${s.address().port}`; yes({ origin: o, published: [`${o}/ips-v4`, `${o}/ips-v6`], close: () => { for (const k of sockets) k.destroy(); s.closeAllConnections(); s.close(); } }); }));
}
const checkStack = async (broken) => { const st = await stack(broken); try { return await checkSoulGame({ origin: st.origin, published: st.published, token: 'sim_check', eventMs: 500, waitMs: 1500 }); } finally { st.close(); } };

test('A3: the check passes against a stack that keeps all six points', async (t) => {
  const r = await checkStack();
  t.diagnostic(`check-soul-game output:\n${r.seen.map((x) => `  ${x}`).join('\n')}\n${r.pass ? 'PASS' : 'FAIL'}`);
  assert.equal(r.pass, true, r.problems.join('\n'));
  assert.equal(r.seen.length, 7, r.seen.join('\n'));
});

test('A3: each of the six points, broken alone, fails the check for its own reason', async () => {
  const want = {
    address: /^address: the launcher keyed 192\.0\.2\.10, the CDN saw 198\.51\.100\.5$/,
    forged: /^forged: the launcher keyed the forged X-Forwarded-For 203\.0\.113\.77$/,
    viewer: /^viewer: no welcome in 1500 ms$/,
    agent: /^agent: GET \/__sim\/healthz: challenged \(cf-mitigated: challenge\)/,
    events: /^events: no first event in 500 ms/,
    ranges: /^ranges: trusted but no longer published|^ranges: published but not trusted: 203\.0\.113\.0\/24$/,
  };
  for (const p of POINTS) {
    const r = await checkStack(p);
    assert.equal(r.pass, false, `${p} broken still passes`);
    assert.equal(r.problems.length, 1, `${p}: ${r.problems.join(' | ')}`);
    assert.match(r.problems[0], want[p]);
  }
  // no token: the event stream cannot be timed, which is a failure, not a pass
  const st = await stack(); try { const r = await checkSoulGame({ origin: st.origin, published: st.published, points: ['events'] }); assert.match(r.problems.join(), /^events: no Soul token/); } finally { st.close(); }
});
