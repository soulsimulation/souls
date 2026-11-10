// node --test tools/world-launcher/soul-cli-h1.test.mjs — #1724/#1750: the CLI's Soul API calls go over HTTP/1.1 with a
// connection each, so a POST never shares a connection with serve's long-polls (Node 26's fetch negotiates HTTP/2 with an
// h2 server). The server here offers h2 and HTTP/1.1, as Caddy does, and records what each request came in on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSecureServer } from 'node:http2';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { worldFetch } from './soul/eden.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('over TLS with h2 offered: long-polls and POSTs come in as HTTP/1.1, and a POST answers while two long-polls are held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-h1-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const seen = [];
  const server = createSecureServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')), allowHTTP1: true }, (req, res) => {
    seen.push(`${req.method} ${req.url.split('?')[0]} ${req.httpVersion}`);
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const hold = req.url.startsWith('/v1/edge/inbox/listen') || req.url.startsWith('/v1/edge/wait') ? 1500 : 0;
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json', 'server-timing': 'world;dur=1.0' }); res.end(JSON.stringify({ ok: true, got: body.length })); }, hold);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const base = `https://localhost:${server.address().port}`;
    const polls = [worldFetch(`${base}/v1/edge/inbox/listen?timeoutMs=1500`), worldFetch(`${base}/v1/edge/wait?timeout=1`)];
    await sleep(100);
    const t0 = performance.now();
    const act = await worldFetch(`${base}/v1/edge/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability: 'walk:x' }) });
    const data = JSON.parse(await act.text()), ms = performance.now() - t0;
    assert.equal(act.status, 200); assert.equal(data.got, 23); assert.equal(act.headers.get('server-timing'), 'world;dur=1.0');
    assert.ok(ms < 1000, `the POST answered in ${Math.round(ms)} ms while two long-polls were held`);
    for (const p of await Promise.all(polls)) assert.equal(p.status, 200);
    assert.deepEqual(seen.map((x) => x.split(' ').pop()), ['1.1', '1.1', '1.1'], seen.join('; '));
    // for the record: what Node's own fetch negotiates with the same server (h2 on Node 24+, HTTP/1.1 on 22)
    seen.length = 0; await (await fetch(`${base}/v1/edge/here`)).text();
    console.log(`# node ${process.version}: fetch came in as ${seen[0]}; worldFetch as HTTP/1.1`);
  } finally { if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev; server.close(); }
});

test('worldFetch: a gzip answer is read as text, headers are read case-insensitively, an abort rejects, a cut answer is "terminated"', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/gz') { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'X-Sim-Load': 'amber' }); res.end(gzipSync('{"a":1}')); return; }
    if (req.url === '/cut') { res.writeHead(200, { 'content-length': '100' }); res.write('{"a"'); setTimeout(() => res.destroy(), 20); return; }
    setTimeout(() => { if (!res.destroyed) res.end('{}'); }, 2000);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const gz = await worldFetch(`${base}/gz`);
    assert.equal(await gz.text(), '{"a":1}'); assert.equal(gz.headers.get('x-sim-load'), 'amber'); assert.equal(gz.headers.get('nope'), null);
    await assert.rejects(worldFetch(`${base}/slow`, { signal: AbortSignal.timeout(100) }));
    const cut = await worldFetch(`${base}/cut`);
    await assert.rejects(cut.text(), /terminated/);
  } finally { server.closeAllConnections(); server.close(); }
});
