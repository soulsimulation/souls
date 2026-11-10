// node --test tools/world-launcher/server-timing.test.mjs — #1750 A2 (#981's fold-in): an answer through the launcher
// carries the launcher's own wait and the world's answer as seen from here (`launcher;dur`, `upstream;dur`) after
// whatever the world said; an answer the launcher gives itself says so (`launcher;…desc=answered`). Fake worlds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';
const P0 = await testPort(4);

test('Server-Timing: a proxied answer adds launcher and upstream; a launcher refusal says it answered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'srv-timing-'));
  const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
  const webDir = join(dir, 'web'); mkdirSync(webDir); writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
  const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
  const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_EDGE: '1' } });
  const L = await openLauncher({ port: P0, range: [P0 + 1, P0 + 3], dataDir: join(dir, 'data'), webDir, templatesDir, command, eager: 0, log: () => {}, prewarm: false, publicOrigin: 'http://sim.test', devAuth: true });
  const base = `http://127.0.0.1:${P0}`;
  try {
    const { slug } = await (await fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Timer' }) })).json();
    await (await fetch(`${base}/w/${slug}/v1/config`)).arrayBuffer();
    const here = await fetch(`${base}/w/${slug}/v1/edge/here`, { headers: { authorization: 'Bearer sim_s_a_secret' } }); await here.arrayBuffer();
    const st = here.headers.get('server-timing') ?? '';
    assert.match(st, /launcher;dur=\d+\.\d, upstream;dur=\d+\.\d$/, st);
    // a heavy request with no token: the launcher answers it (401) without the world
    const no = await fetch(`${base}/w/${slug}/v1/edge/act`, { method: 'POST', body: '{}' }); await no.arrayBuffer();
    assert.equal(no.status, 401); assert.match(no.headers.get('server-timing') ?? '', /^launcher;dur=\d+\.\d;desc=answered$/);
    const none = await fetch(`${base}/w/no-such-world/v1/edge/here`); await none.arrayBuffer();
    assert.equal(none.status, 404); assert.match(none.headers.get('server-timing') ?? '', /desc=answered/);
  } finally { await L.close(); }
});
