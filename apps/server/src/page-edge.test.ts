// #2515 (Scaling E3): the world page is the same bytes for a signed-in browser and anyone else (so the launcher may keep
// it for every arrival), and is marked X-Sim-Page; /v1/config without a token carries the CDN's brief-keep header, never with one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toyFactory } from '@souls/engine-toy';
import { Auth } from './auth.ts';
import { Brain } from './brain.ts';
import { config } from './config.ts';
import { Db } from './db.ts';
import { buildApp } from './http.ts';
import type { Hub } from './hub.ts';
import { Souls } from './souls.ts';
import { WorldHost } from './world.ts';

test('the page a signed-in browser gets is byte-identical to an anonymous one; config carries the edge header only without a token', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'page-edge-')), db = new Db(':memory:');
  const host = new WorldHost(db, toyFactory, 'page-edge', 1e9, 'page-edge-toy'); host.boot();
  writeFileSync(join(dir, 'index.html'), readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'));
  const cfg = { ...config, worldKey: 'toy', worldId: host.worldId, worldPath: '/w/toy', publicUrl: 'https://soul.game/w/toy', webDir: dir, marsWebDir: '/nonexistent',
    brainMode: 'fake' as const, budgetUsdPerDay: 0, typesafeKey: undefined, anthropicKey: undefined, privyAppId: '', privyAppSecret: '' };
  const auth = new Auth(cfg, db), brain = new Brain(host, db, cfg, { clients: () => 0, onCall() {}, onCamera() {}, onTicker() {}, onNarrative() {} }), souls = new Souls(host, db, brain, cfg);
  const app = buildApp({ cfg, db, host, auth, brain, souls, hub: { clients: new Map(), refreshMe() {} } as unknown as Hub });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const site = { host: 'soul.game', 'x-forwarded-proto': 'https' };
  const anon = await app.request('/', { headers: site });
  const signedIn = await app.request('/', { headers: { ...site, accept: 'text/html', cookie: '__session=eyJ.signed.in; __client_uat=1' } });
  const query = await app.request('/?ref=launch', { headers: site });
  assert.equal(anon.headers.get('x-sim-page'), 'index', 'the page, indexable without a query');
  assert.equal((await app.request('/somewhere', { headers: site })).headers.get('x-sim-page'), 'world', 'the page under another path, never indexable');
  assert.equal(anon.headers.get('set-cookie'), null, 'the page never sets a cookie');
  const bytes = Buffer.from(await anon.arrayBuffer());
  assert.ok(bytes.includes('window.__simConfig'));
  assert.deepEqual(Buffer.from(await signedIn.arrayBuffer()), bytes, 'a signed-in browser gets the same bytes');
  assert.deepEqual(Buffer.from(await query.arrayBuffer()), bytes, 'and so does a query variant');
  assert.equal((await app.request('/skill.md')).headers.get('x-sim-page'), null, 'only the page is marked');
  const cfgAnon = await app.request('/v1/config', { headers: site });
  assert.equal(cfgAnon.headers.get('cloudflare-cdn-cache-control'), 'max-age=5, stale-while-revalidate=30');
  const cfgToken = await app.request('/v1/config', { headers: { ...site, authorization: 'Bearer sim_x' } });
  assert.equal(cfgToken.status, 200); assert.equal(cfgToken.headers.get('cloudflare-cdn-cache-control'), null);
});
