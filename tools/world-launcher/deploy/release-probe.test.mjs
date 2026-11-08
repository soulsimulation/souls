// release-probe.mjs against a loopback origin, in real Chrome (#1414). Not in CI's tools/world-launcher/*.test.mjs glob:
// it needs Google Chrome (the probe launches channel 'chrome'). Run: node --test tools/world-launcher/deploy/release-probe.test.mjs
// The origin answers 503 for /w/eden/ until it is "up", then a page whose world socket welcome names a build: the state
// a release that fixes a halted world starts from (the 4.16.1 ship). RELEASE_PROBE=<file> runs another copy of the probe.
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

function origin({ upAfterMs }) {
  const t0 = Date.now(), sockets = new Set();
  const server = createServer((req, res) => {
    const up = upAfterMs !== null && Date.now() - t0 >= upAfterMs;
    if (!up) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('world unavailable'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const msg = Buffer.from(JSON.stringify({ t: 'welcome', build: BUILD }));
    socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
    socket.on('data', () => {}); socket.on('error', () => {}); sockets.add(socket);
  });
  return new Promise((yes) => server.listen(0, '127.0.0.1', () => yes({ url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const s of sockets) s.destroy(); server.close(); } })));
}

async function probe(upAfterMs) {
  const o = await origin({ upAfterMs }), out = mkdtempSync(join(tmpdir(), 'release-probe-'));
  const child = spawn(process.execPath, [PROBE, '--origin', o.url, '--pages', '/w/eden/', '--phone-pages', '/w/eden/', '--out', out,
    '--expect-build', BUILD, '--settle-s', '1', '--after-s', '4', '--arrive-every', '2', '--retry-s', '1', '--max-min', '2'], { env: { ...process.env, SIM_CHROME_LEASE: '' } });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  // release right after READY, as ship.sh does once the activation returns
  const t = setInterval(() => { if (existsSync(join(out, 'ready')) && !existsSync(join(out, 'released'))) writeFileSync(join(out, 'released'), ''); }, 200);
  const code = await new Promise((yes) => child.on('exit', yes));
  clearInterval(t); o.close();
  const report = existsSync(join(out, 'report.json')) ? JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) : null;
  return { code, log, bar: report?.bar };
}

test('a page that answers 503 when the probe starts is retried, and the build it then shows is read: no false rollback', { timeout: 120_000 }, async () => {
  const r = await probe(4000);
  assert.ok(r.bar, r.log);
  assert.deepEqual(r.bar.rolledBack, [], r.log);
  assert.deepEqual(r.bar.notLoaded, [], r.log);
  assert.deepEqual(r.bar.builds, { 'desktop /w/eden/': `null -> ${BUILD}`, 'phone /w/eden/': `null -> ${BUILD}` });
  assert.ok(r.bar.errorPagesBeforeReady >= 2, 'the starting 503s are reported');
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
