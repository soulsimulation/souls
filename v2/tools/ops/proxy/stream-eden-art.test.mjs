// #4159: stream.eden.art's Caddy site serves only /s/* from the viewers' origin, with the origin's own headers, and a
// no-store 404 for everything else. Runs the real site file under Caddy (skipped without `caddy` on PATH or $CADDY),
// with only its address and the origin's port swapped for local ones.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createOrigin } from '../../origin/origin.mjs';

const CADDY = process.env.CADDY || 'caddy';
const hasCaddy = spawnSync(CADDY, ['version']).status === 0;
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

test('#4159: the stream site proxies /s/* to the origin unchanged and answers anything else with a no-store 404', { skip: !hasCaddy && 'caddy not found' }, async () => {
  const scratch = fileURLToPath(new URL('../../../../.local/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'stream-site-'));
  mkdirSync(join(dir, 'www/eden'), { recursive: true });
  writeFileSync(join(dir, 'www/eden/7'), 'part');
  writeFileSync(join(dir, 'www/eden/pointer'), 'p');
  const { server } = createOrigin(join(dir, 'www'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = await freePort();
  const site = readFileSync(new URL('./stream-eden-art.caddy', import.meta.url), 'utf8');
  assert.match(site, /^https:\/\/stream\.eden\.art \{$/m);
  assert.match(site, /reverse_proxy localhost:7320$/m);
  writeFileSync(join(dir, 'Caddyfile'), '{\n\tadmin off\n}\n' + site.replace('https://stream.eden.art {', `http://127.0.0.1:${port} {`).replace('localhost:7320', `127.0.0.1:${server.address().port}`));
  const caddy = spawn(CADDY, ['run', '--config', join(dir, 'Caddyfile'), '--adapter', 'caddyfile'], { stdio: 'ignore' });
  const at = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(at + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const part = await fetch(`${at}/s/eden/7`);
    assert.deepEqual([part.status, await part.text(), part.headers.get('cache-control'), part.headers.get('access-control-allow-origin'), part.headers.get('x-robots-tag')],
      [200, 'part', 'public, max-age=31536000, immutable, no-transform', '*', 'noindex, nofollow']);
    const ptr = await fetch(`${at}/s/eden/pointer`);
    assert.deepEqual([ptr.status, ptr.headers.get('cache-control')], [200, 'public, max-age=1, no-transform']);
    const early = await fetch(`${at}/s/eden/8`);
    assert.deepEqual([early.status, early.headers.get('cache-control'), early.headers.get('access-control-allow-origin')], [404, 'no-store', '*']);
    for (const p of ['/', '/w/eden/', '/v1/worlds', '/eden/7', '/w/eden/v2/ws']) {
      const r = await fetch(at + p);
      assert.deepEqual([r.status, r.headers.get('cache-control')], [404, 'no-store'], p);
    }
  } finally { caddy.kill(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});
