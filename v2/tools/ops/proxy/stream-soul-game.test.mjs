// stream.soul.game's site file (#4159), run in a real Caddy (on PATH or $CADDY; skipped, and so unproved, without one)
// in front of the real viewers' origin (v2/tools/origin/origin.mjs) on loopback. It checks what the CDN will be given:
// /s/* answers exactly as the origin does, with `Access-Control-Allow-Origin: *` and no cookie; a preflight is answered
// here; anything else is a 404 no one keeps; the file validates as installed (with cdn-trust.snippet).
//   node --test v2/tools/ops/proxy/stream-soul-game.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const HERE = new URL('./', import.meta.url).pathname;
const SITE = readFileSync(join(HERE, 'stream-soul-game.caddy'), 'utf8');
const TRUST = readFileSync(join(HERE, '../../../../tools/world-launcher/deploy/caddy/cdn-trust.snippet'), 'utf8');
const ORIGIN = join(HERE, '../../origin/origin.mjs');
const CADDY = process.env.CADDY ?? 'caddy';
const skip = spawnSync(CADDY, ['version'], { encoding: 'utf8' }).status !== 0 && 'no caddy binary (set $CADDY)';
const dir = mkdtempSync(join(tmpdir(), 'stream-soul-game-'));
const kids = [];
after(() => { for (const k of kids) k.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
const env = { ...process.env, HOME: dir, XDG_DATA_HOME: join(dir, 'xdg-data'), XDG_CONFIG_HOME: join(dir, 'xdg-config') };

function layout(name, site, global = 'admin off') {
  const d = join(dir, name);
  mkdirSync(join(d, 'sites'), { recursive: true });
  writeFileSync(join(d, 'cdn-trust.snippet'), TRUST);
  writeFileSync(join(d, 'sites', 'stream-soul-game.caddy'), site);
  writeFileSync(join(d, 'Caddyfile'), `{\n\t${global}\n\timport cdn-trust.snippet\n}\nimport sites/*.caddy\n`);
  return join(d, 'Caddyfile');
}
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const started = (cmd, args, re, opts) => new Promise((ok, no) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  kids.push(p);
  let out = '';
  const on = (d) => { out += d; const m = re.exec(out); if (m) ok(m); };
  p.stdout.on('data', on); p.stderr.on('data', on);
  p.on('exit', (c) => no(Error(`${cmd} ended (${c}): ${out.slice(-1500)}`)));
});

test('the site file validates in the production layout', { skip }, () => {
  assert.match(SITE, /^https:\/\/stream\.soul\.game \{$/m);
  assert.match(SITE, /reverse_proxy localhost:7320 \{/, 'the viewers\' origin, as soul.game\'s /s/*');
  const r = spawnSync(CADDY, ['validate', '--config', layout('validate', SITE, 'admin 127.0.0.1:2019'), '--adapter', 'caddyfile'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
});

test('through Caddy: /s/* is the origin\'s answer with CORS and no cookie; a preflight is answered; anything else a no-store 404', { skip }, async () => {
  const views = join(dir, 'views', 'eden');
  mkdirSync(views, { recursive: true });
  writeFileSync(join(views, 'pointer'), 'pointer bytes');
  writeFileSync(join(views, '0'), 'part zero');
  const op = (await started(process.execPath, [ORIGIN, join(dir, 'views'), '0', '127.0.0.1'], /origin (\d+)\n/, { env: { ...process.env, ORIGIN_PROCESSES: '1' } }))[1];
  const cp = await freePort();
  const site = SITE.replace(/^https:\/\/stream\.soul\.game \{$/m, `http://:${cp} {\n\tbind 127.0.0.1`).replace('localhost:7320', `127.0.0.1:${op}`);
  await started(CADDY, ['run', '--config', layout('run', site), '--adapter', 'caddyfile'], /serving initial configuration/, { env });
  const o = `http://127.0.0.1:${cp}`, page = { origin: 'https://soul.game' };

  const part = await fetch(`${o}/s/eden/0`, { headers: page });
  assert.equal(part.status, 200); assert.equal(await part.text(), 'part zero');
  assert.equal(part.headers.get('cache-control'), 'public, max-age=31536000, immutable, no-transform', 'the origin\'s own header: kept a year');
  assert.equal(part.headers.get('access-control-allow-origin'), '*');
  assert.equal(part.headers.get('x-souls-system'), 'v2');
  const ptr = await fetch(`${o}/s/eden/pointer`, { headers: page });
  assert.equal(ptr.status, 200); assert.equal(ptr.headers.get('cache-control'), 'public, max-age=1, no-transform', 'the pointer: one second');
  assert.equal(ptr.headers.get('access-control-allow-origin'), '*'); await ptr.text();
  const range = await fetch(`${o}/s/eden/0`, { headers: { ...page, range: 'bytes=0-3' } });
  assert.equal(range.status, 206); assert.equal(await range.text(), 'part'); assert.equal(range.headers.get('access-control-allow-origin'), '*');
  for (const path of ['/s/eden/1', '/s/eden/pointer?x=1', '/s/../etc/passwd']) {
    const r = await fetch(o + path, { headers: page });
    assert.equal(r.status, 404, path); assert.equal(r.headers.get('cache-control'), 'no-store', path); await r.text();
  }
  const missing = await fetch(`${o}/s/eden/1`, { headers: page });
  assert.equal(missing.headers.get('access-control-allow-origin'), '*', 'a 404 the page can read: the reader tries again'); await missing.text();

  const pre = await fetch(`${o}/s/eden/0`, { method: 'OPTIONS', headers: { ...page, 'access-control-request-method': 'GET', 'access-control-request-headers': 'range' } });
  assert.equal(pre.status, 204);
  assert.deepEqual(['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'cache-control'].map((h) => pre.headers.get(h)), ['*', 'GET, HEAD', 'range', 'no-store']);

  for (const path of ['/', '/w/eden/', '/v1/config', '/__sim/healthz', '/w/eden/v2/ws']) {
    const r = await fetch(o + path, { headers: page });
    assert.equal(r.status, 404, path); assert.equal(r.headers.get('cache-control'), 'no-store', path); await r.text();
  }
  for (const r of [part, ptr, range, missing, pre]) assert.equal(r.headers.get('set-cookie'), null);
});
