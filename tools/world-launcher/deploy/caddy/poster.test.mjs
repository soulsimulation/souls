// soul.game's poster while the launcher cannot answer (#2517): the real site file in a real Caddy (needs a `caddy`
// binary on PATH or in $CADDY; skipped, and so unproved, without one) in front of a launcher port with nothing on it.
// A1: a page a browser asks for gets the poster; /__sim/healthz, API paths and non-GETs keep the real 502.
// A2: the poster's own reload script, run as a browser would (each reload after the delay it picks), reaches the world
// page within 10 s of the launcher starting. A3: the site file validates. No network beyond loopback.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { testPort } from '../../../lib/test-port.ts';

const HERE = new URL('./', import.meta.url).pathname;
const SITE = readFileSync(join(HERE, 'soul-game.caddy'), 'utf8'), TRUST = readFileSync(join(HERE, 'cdn-trust.snippet'), 'utf8');
const POSTER = readFileSync(join(HERE, 'poster.html'), 'utf8');
const CADDY = process.env.CADDY ?? 'caddy';
const hasCaddy = spawnSync(CADDY, ['version'], { encoding: 'utf8' }).status === 0;
const skip = !hasCaddy && 'no caddy binary (set $CADDY)';
const dir = mkdtempSync(join(tmpdir(), 'soul-game-poster-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const caddyEnv = { ...process.env, HOME: dir, XDG_DATA_HOME: join(dir, 'xdg-data'), XDG_CONFIG_HOME: join(dir, 'xdg-config') };
const RELEASE_DIR = '/srv/sim-worlds/production/tools/world-launcher/deploy/caddy';
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function layout(name, site, global = 'admin off') {
  const d = join(dir, name); mkdirSync(join(d, 'sites'), { recursive: true });
  writeFileSync(join(d, 'cdn-trust.snippet'), TRUST);
  writeFileSync(join(d, 'sites', 'soul-game.caddy'), site);
  writeFileSync(join(d, 'Caddyfile'), `{\n\t${global}\n\timport cdn-trust.snippet\n}\nimport sites/*.caddy\n`);
  return join(d, 'Caddyfile');
}

test('A3: the site file with the poster passes caddy validate in the production layout', { skip }, () => {
  assert.ok(SITE.includes(`root * ${RELEASE_DIR}`), 'the poster is read from the live release');
  const r = spawnSync(CADDY, ['validate', '--config', layout('validate', SITE.replaceAll('@@PRODUCTION_PORT@@', '4600'), 'admin 127.0.0.1:2019'), '--adapter', 'caddyfile'], { encoding: 'utf8', env: caddyEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr + r.stdout, /Valid configuration/);
});

test('the poster makes no request of its own and reloads after a random 3 to 8 s', () => {
  assert.doesNotMatch(POSTER, /\b(?:src|href)=|url\(|@import|fetch\(|XMLHttpRequest/, 'no request beyond the page itself');
  const delays = [0, 0.5, 0.999999].map((rnd) => { let ms; runInNewContext(script(), { setTimeout: (_, d) => { ms = d; }, Math: { random: () => rnd, floor: Math.floor }, location: {} }); return ms; });
  assert.deepEqual(delays, [3000, 5500, 7999]);
});
const script = () => /<script>([\s\S]*?)<\/script>/.exec(POSTER)[1];

/** The site file as it is, on loopback: plain http on a test port, the poster read from this folder. */
async function startCaddy(lp, cp) {
  const site = SITE.replaceAll('@@PRODUCTION_PORT@@', String(lp)).replace(/^https:\/\/soul\.game \{$/m, `http://:${cp} {\n\tbind 127.0.0.1`).replace(`root * ${RELEASE_DIR}`, `root * ${HERE}`);
  const caddy = spawn(CADDY, ['run', '--config', layout('run', site), '--adapter', 'caddyfile'], { env: caddyEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; caddy.stderr.on('data', (d) => { err += d; });
  for (let i = 0; ; i++) { try { await fetch(`http://127.0.0.1:${cp}/__sim/healthz`); return caddy; } catch { if (i > 100 || caddy.exitCode !== null) throw Error(`caddy did not start: ${err.slice(-2000)}`); await new Promise((r) => setTimeout(r, 100)); } }
}
/** A stand-in launcher: the world page, and the health check. */
const WORLD = '<!doctype html><title>Eden</title><div id="root"></div>';
const launcher = (port) => new Promise((yes) => { const s = createServer((req, res) => req.url === '/__sim/healthz' ? res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}') : res.writeHead(200, { 'content-type': 'text/html' }).end(WORLD)); s.listen(port, '127.0.0.1', () => yes(s)); });

test('A1 + A2: with the launcher stopped a browser gets the poster and agents the real 502; when it starts, the poster reaches the world within 10 s', { skip }, async (t) => {
  const base = await testPort(2), lp = base, cp = base + 1, o = `http://127.0.0.1:${cp}`;
  const caddy = await startCaddy(lp, cp);
  let L;
  try {
    // A1: the launcher is stopped (nothing listens on its port)
    const page = await fetch(`${o}/w/eden/`, { headers: { accept: BROWSER } }), body = await page.text();
    assert.equal(page.status, 503); assert.equal(body, POSTER);
    assert.equal(page.headers.get('cache-control'), 'no-store'); assert.equal(page.headers.get('retry-after'), '5');
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    const curl = await fetch(`${o}/__sim/healthz`, { headers: { accept: '*/*', 'user-agent': 'curl/8.7.1' } });
    assert.equal(curl.status, 502, 'curl to /__sim/healthz gets the real 502'); assert.doesNotMatch(await curl.text(), /Back in a moment/);
    for (const [path, init] of [['/__sim/healthz', { headers: { accept: BROWSER } }], ['/v1/config', { headers: { accept: BROWSER } }], ['/w/eden/v1/config', { headers: { accept: BROWSER } }],
      ['/w/eden/v1/world/snapshot', { headers: { accept: 'application/json' } }], ['/w/eden/', { headers: { accept: 'application/json' } }], ['/w/eden/', { method: 'POST', headers: { accept: BROWSER } }],
      ['/assets/index-AbCd1234.js', { headers: { accept: '*/*' } }]]) {
      const r = await fetch(o + path, init); assert.equal(r.status, 502, `${init.method ?? 'GET'} ${path} (${init.headers.accept})`); await r.text();
    }
    t.diagnostic(`A1: GET /w/eden/ (browser) -> ${page.status} poster; GET /__sim/healthz (curl) -> ${curl.status}`);

    // A2: a browser on the poster, reloading as the poster's script says; the launcher starts at a random moment
    const t0 = performance.now(), upAt = 1000 + Math.random() * 4000;
    setTimeout(async () => { L = await launcher(lp); }, upAt);
    let reached = null, reloads = 0;
    while (performance.now() - t0 < 30_000) {
      const r = await fetch(`${o}/w/eden/`, { headers: { accept: BROWSER } }), html = await r.text();
      if (r.status === 200 && html === WORLD) { reached = performance.now() - t0 - upAt; break; }
      assert.equal(html, POSTER); reloads++;
      let ms; runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], { setTimeout: (_, d) => { ms = d; }, Math, location: {} });
      await new Promise((res) => setTimeout(res, ms));
    }
    t.diagnostic(`A2: the launcher started ${Math.round(upAt)} ms in; the world page arrived ${Math.round(reached)} ms after that, ${reloads} poster load(s)`);
    assert.ok(reached !== null && reached < 10_000, `reached the world ${reached} ms after the launcher started`);
  } finally { caddy.kill(); L?.close(); }
});
