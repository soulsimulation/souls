// release-probe.mjs against a loopback origin, in real Chrome (#1414). Not in CI's tools/world-launcher/*.test.mjs glob:
// it needs Google Chrome (the probe launches channel 'chrome'). Run: node --test tools/world-launcher/deploy/release-probe.test.mjs
// The origin answers 503 for /w/eden/ until it is "up", then a page whose world socket welcome names a build: the state
// a release that fixes a halted world starts from (the 0.120.1 ship). RELEASE_PROBE=<file> runs another copy of the probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE = process.env.RELEASE_PROBE || join(dirname(fileURLToPath(import.meta.url)), 'release-probe.mjs');
const BUILD = 'we-aaaaaaaaaaaa';
const PAGE = `<!doctype html><title>eden</title><body>Eden<script>
const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/w/eden/ws');
</script></body>`;
// 24 Nov: a page the new engine runs reads its stream (bridge.ts `__soulsV2`, newest world time) and opens no world socket
const V2_PAGE = (moving) => `<!doctype html><title>eden</title><script>window.__simConfig={"worldKey":"eden","v2Stream":"/s/eden/"}</script><body>Eden<script>
window.__soulsV2 = { newestTo: 1, error: null };${moving ? ' setInterval(() => { window.__soulsV2.newestTo += 50000; }, 200);' : ''}
</script></body>`;
// the drop the dry run of 24 Nov saw: the page closes a world socket itself (code 1005, as the unadopted entry socket
// did 20 s after it opened) and opens no other: nothing resumes it
const DROP_PAGE = `<!doctype html><title>eden</title><body>Eden<script>
const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/w/drop/ws'); setTimeout(() => ws.close(), 3000);
</script></body>`;

function origin({ upAfterMs, builds = {}, siteBefore = null }) {
  const t0 = Date.now(), sockets = new Set(); let site = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname, up = path !== '/w/down/' && upAfterMs !== null && Date.now() - t0 >= upAfterMs;
    if (!up) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('world unavailable'); return; }
    if (path === '/__sim/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, build: siteBefore && site++ < 2 ? siteBefore : BUILD })); return; }   // siteBefore: the build before the release (the two marks' reads)
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(path === '/w/v2/' ? V2_PAGE(true) : path === '/w/v2-stuck/' ? V2_PAGE(false) : path === '/w/drop/' ? DROP_PAGE : PAGE.replace("'/w/eden/ws'", `'${path}ws'`));
  });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const msg = Buffer.from(JSON.stringify({ t: 'welcome', build: builds[new URL(req.url, 'http://x').pathname] ?? BUILD }));
    socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
    // a close frame from the page is answered, so its close event fires as it does against the launcher
    socket.on('data', (d) => { if ((d[0] & 0x0f) === 8) socket.end(Buffer.from([0x88, 0])); }); socket.on('error', () => {}); sockets.add(socket);
  });
  return new Promise((yes) => server.listen(0, '127.0.0.1', () => yes({ url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const s of sockets) s.destroy(); server.close(); } })));
}

async function probe(upAfterMs, { pages = '/w/eden/', phonePages = '/w/eden/', builds, siteBefore } = {}) {
  const o = await origin({ upAfterMs, builds, siteBefore }), out = mkdtempSync(join(tmpdir(), 'release-probe-'));
  const child = spawn(process.execPath, [PROBE, '--origin', o.url, '--pages', pages, '--phone-pages', phonePages, '--out', out,
    '--expect-build', BUILD, '--settle-s', '1', '--after-s', '4', '--arrive-every', '2', '--retry-s', '1', '--max-min', '2'], { env: { ...process.env, SIM_CHROME_LEASE: '' } });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  // release right after READY, as ship.sh does once the activation returns
  const t = setInterval(() => { if (existsSync(join(out, 'ready')) && !existsSync(join(out, 'released'))) writeFileSync(join(out, 'released'), ''); }, 200);
  const code = await new Promise((yes) => child.on('exit', yes));
  clearInterval(t); o.close();
  const report = existsSync(join(out, 'report.json')) ? JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) : null;
  return { code, log, bar: report?.bar, arrivalErrors: report?.arrivals.filter((a) => a.errorText || (a.status !== null && !(a.status >= 200 && a.status < 400))).length };
}

test('a page that answers 503 when the probe starts is retried, and the build it then shows is read: no false rollback', { timeout: 120_000 }, async () => {
  const r = await probe(4000);
  assert.ok(r.bar, r.log);
  assert.deepEqual(r.bar.rolledBack, [], r.log);
  assert.deepEqual(r.bar.notLoaded, [], r.log);
  assert.deepEqual(r.bar.builds, { 'desktop /w/eden/': `null -> ${BUILD}`, 'phone /w/eden/': `null -> ${BUILD}` });
  assert.ok(r.bar.errorPagesBeforeReady >= 2, 'the starting 503s are reported apart');
  assert.equal(r.bar.errorPages, r.arrivalErrors, 'only what fresh visitors saw counts against the release');
  assert.equal(r.code === 3, false, r.log);
});

test('a page that never loads is notLoaded (exit 1), never a rollback (exit 3)', { timeout: 120_000 }, async () => {
  const r = await probe(null);
  assert.equal(r.code, 1, r.log);
  assert.deepEqual(r.bar.rolledBack, []);
  assert.equal(r.bar.notLoaded.length, 2);
  assert.match(r.bar.notLoaded[0], /never loaded \(first 503, last 503/);
  assert.doesNotMatch(r.log, /ROLLED BACK/);
});

test('a page that ended on another build is a rollback (exit 3) even while another page never loaded', { timeout: 120_000 }, async () => {
  const r = await probe(0, { pages: '/w/eden/', phonePages: '/w/down/', builds: { '/w/eden/ws': 'we-bbbbbbbbbbbb' } });
  assert.equal(r.code, 3, r.log);
  assert.deepEqual(r.bar.rolledBack, [`desktop /w/eden/: serves we-bbbbbbbbbbbb, not ${BUILD}`]);
  assert.equal(r.bar.notLoaded.length, 1);
  assert.match(r.log, /ROLLED BACK/);
});

test('a page that reads a v2 stream: the site\'s build, and a stream that advances, pass with no world socket', { timeout: 120_000 }, async () => {
  const r = await probe(0, { pages: '/w/v2/', phonePages: '/w/v2/' });
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(r.bar.builds, { 'desktop /w/v2/': `${BUILD} -> ${BUILD}`, 'phone /w/v2/': `${BUILD} -> ${BUILD}` });
  assert.deepEqual([r.bar.drops, r.bar.streamStuck, r.bar.noBuild], [0, [], []]);
});

test('a v2 page whose stream stops is streamStuck (exit 1): a viewer on a stale world', { timeout: 120_000 }, async () => {
  const r = await probe(0, { pages: '/w/v2-stuck/', phonePages: '/w/v2-stuck/' });
  assert.equal(r.code, 1, r.log);
  assert.equal(r.bar.streamStuck.length, 2); assert.match(r.bar.streamStuck[0], /stream did not advance \(1 -> 1\)/);
  assert.match(r.log, /STREAM STUCK/);
});

test('a world socket the page closes itself and never replaces is not resumed (exit 1), and the bar says which', { timeout: 120_000 }, async () => {
  const r = await probe(0, { pages: '/w/drop/', phonePages: '/w/drop/' });
  assert.equal(r.code, 1, r.log);
  assert.equal(r.bar.notResumed, 2, r.log);
  assert.match(r.bar.notResumedAt[0], /^desktop \/w\/drop\/: closed \(1005\) at \+\d/);
});

// 0.132.4 (run 45352560019): an open v2 page keeps running across a compatible release (no reload, #2368) and reads no
// world socket after its entry socket, so a socket's welcome named the old build to the end: rolledBack=2 for a release
// that landed. Its build is the site's, which changes with the release.
test('a v2 page across a release that lands: the site\'s new build, no false rollback', { timeout: 120_000 }, async () => {
  const r = await probe(0, { pages: '/w/v2/', phonePages: '/w/v2/', siteBefore: 'we-000000000000' });
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(r.bar.builds, { 'desktop /w/v2/': `we-000000000000 -> ${BUILD}`, 'phone /w/v2/': `we-000000000000 -> ${BUILD}` });
  assert.deepEqual(r.bar.rolledBack, []);
});
