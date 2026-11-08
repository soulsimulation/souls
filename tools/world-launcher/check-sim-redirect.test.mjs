// deploy/caddy/check-sim-redirect.mjs against loopback origins (#1416): the redirect sim-eden-art.caddy describes passes;
// a redirected sign-in, a dropped query, a wrong status or a wrong host fails. No network beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRedirect } from './deploy/caddy/check-sim-redirect.mjs';

const listen = (handler) => new Promise((yes) => { const s = createServer(handler).listen(0, '127.0.0.1', () => yes({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() })); });
const BRIDGE = '<!doctype html><title>Sign in to Souls</title><main id="sign-in">Loading sign-in…</main><script src="https://clerk.example.test/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>';

// what the Caddy file does, with switches to break one thing at a time
function oldOrigin(canonical, broken = {}) {
  return listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/sign-in' && !broken.signIn) {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }); res.end(BRIDGE); return;
    }
    const status = broken.status ?? (['GET', 'HEAD'].includes(req.method) ? 301 : 308);
    const target = (broken.host ?? canonical()) + (broken.dropQuery ? url.pathname : req.url);
    res.writeHead(status, { location: target }); res.end();
  });
}

async function run(broken) {
  const canon = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('ok'); });
  const old = await oldOrigin(() => canon.url, broken);
  try { return await checkRedirect({ origin: old.url, canonical: canon.url }); } finally { old.close(); canon.close(); }
}

test('the redirect the site file describes passes', async () => {
  const r = await run();
  assert.equal(r.pass, true, r.problems.join('\n'));
  assert.ok(r.seen.some((s) => /^POST .* 308 /.test(s)), 'a POST gets 308');
});

test('a redirected sign-in, a dropped query, a wrong status or another host fails', async () => {
  for (const [name, broken, want] of [['sign-in redirected', { signIn: true }, /\/sign-in: 301/], ['query dropped', { dropQuery: true }, /mars-college-2026\/\?view=map: location/],
    ['302', { status: 302 }, /302, want 301/], ['another host', { host: 'https://elsewhere.test' }, /location https:\/\/elsewhere\.test/]]) {
    const r = await run(broken);
    assert.equal(r.pass, false, name);
    assert.ok(r.problems.some((p) => want.test(p)), `${name}: ${r.problems.join('; ')}`);
  }
});

test('the site file keeps /sign-in on the origin, serves it from the production launcher\'s own bridge, and redirects the rest 301/308 with the uri', () => {
  const f = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'deploy/caddy/sim-eden-art.caddy'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.match(f, /handle \/sign-in \{\s*rewrite \* \/__sim\/clerk-sign-in\s*reverse_proxy localhost:@@PRODUCTION_PORT@@\s*\}/);
  assert.doesNotMatch(f, /localhost:\d|127\.0\.0\.1|\b\d{1,3}(\.\d{1,3}){3}\b/, 'no port or address in the repository: the placeholder only');
  assert.match(f, /@read method GET HEAD\s*handle @read \{\s*redir https:\/\/soul\.game\{uri\} 301/);
  assert.match(f, /handle \{\s*redir https:\/\/soul\.game\{uri\} 308/);
  assert.ok(f.indexOf('handle /sign-in') < f.indexOf('@read'), 'sign-in is handled before the redirects');
});
