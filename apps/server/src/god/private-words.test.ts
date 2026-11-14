// #1223: a private notebook's words (state.text, state.textBy) stay out of the public snapshot (all three forms), an
// entity read and the viewers' world-diff; the god's own snapshot and stream keep them.
//   node --test apps/server/src/god/private-words.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { coreRef } from '@souls/world-compiler';
import { Db } from '../db.ts';
import { ApiError } from '../souls.ts';
import { GodMode, type WorldDiffMessage } from './god.ts';
import { mountGodRoutes } from './routes.ts';

const SECRET = 'afraid of the dark', WRITER = 's_ana_1223';

function world(t: { after(f: () => void): void }) {
  const root = fileURLToPath(new URL('../../../../.local/', import.meta.url)); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + 'private-words-'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const viewers: WorldDiffMessage[] = [], godEvents: { event: string; data: unknown }[] = [];
  const god = new GodMode(new Db(':memory:'), { worldId: 'pw-1', ownerId: 'dev:owner', tick: () => 1, emit: (m: WorldDiffMessage) => { viewers.push(m); }, assetDir: dir } as never);
  god.subscribe(0, (e) => { godEvents.push(e); });
  const app = new Hono();
  const requireUser = async (c: Context) => { if (c.req.header('authorization') !== 'Bearer dev:owner') throw new ApiError(401, 'unauthorized', 'sign in'); return { id: 'dev:owner', role: 'user', email: null, wallet: null, created_at: 0, last_seen: 0, invited_by: null } as never; };
  mountGodRoutes(app, { god, worldName: 'Private words', requireUser, soulFromBearer: () => null, baseOf: () => 'http://localhost:5990/w/pw', limitIp: () => {} } as never);
  app.onError((err, c) => err instanceof ApiError ? c.json({ ok: false, code: err.code }, err.status as 400) : c.json({ ok: false, message: String(err) }, 500));
  const token = god.mintFor({ id: 'dev:owner', role: 'user' } as never, 'test');
  const get = async (path: string, auth?: string) => (await app.request(path, { headers: auth ? { authorization: `Bearer ${auth}` } : {} })).text();
  return { god, viewers, godEvents, get, token };
}

test('A1: a private notebook\'s words are out of every public read and the viewers\' diff; the god keeps them', async (t) => {
  const w = world(t);
  const placed = w.god.act({ ops: [
    { op: 'place', def: coreRef('notebook-stand'), name: 'diary', p: [4, 4], owner: 'soul:Ana', access: 'private' },
    { op: 'place', def: coreRef('notebook-stand'), name: 'guestbook', p: [-4, 4] },
    { op: 'place', def: coreRef('pavilion'), name: 'den', p: [12, 12], owner: 'soul:Ben', access: 'private' },
  ] } as never);
  assert.equal(placed.accepted, true, JSON.stringify(placed));
  const nested = w.god.act({ ops: [{ op: 'place', def: coreRef('notebook-stand'), name: 'den-book', p: [12, 12], in: { parent: 'den' } }] } as never);
  assert.equal(nested.accepted, true, JSON.stringify(nested));
  w.viewers.length = 0; w.godEvents.length = 0;
  const id = (name: string) => [...w.god.model.entities.values()].find((e) => e.name === name)!.id;
  const wrote = w.god.act({ ops: ['diary', 'guestbook', 'den-book'].map((name) => ({ op: 'set', id: id(name), state: { text: `${name}: ${SECRET} — Ana`, textBy: WRITER } })) } as never);
  assert.equal(wrote.accepted, true, JSON.stringify(wrote));

  // the three public snapshot forms, read with no sign-in
  for (const q of ['', '?defs=ref', '?defs=ref&cols=1']) {
    const body = await w.get('/v1/world/snapshot' + q);
    assert.ok(!body.includes(`diary: ${SECRET}`), `diary words in /v1/world/snapshot${q}`);
    assert.ok(!body.includes(`den-book: ${SECRET}`), `a notebook inside a private building is private (${q})`);
    assert.ok(body.includes(`guestbook: ${SECRET}`), `a public notebook keeps its words (${q})`);
  }
  const plain = JSON.parse(await w.get('/v1/world/snapshot')) as { entities: { id: string; access?: string; state?: Record<string, unknown> }[] };
  const diary = plain.entities.find((e) => e.id === id('diary'))!;
  assert.equal(diary.access, 'private', 'the viewer still learns it is private, so it can draw it closed');
  assert.equal(diary.state?.text, undefined); assert.equal(diary.state?.textBy, undefined);
  assert.equal(w.god.model.get(id('diary'))!.state?.text, `diary: ${SECRET} — Ana`, 'the model itself is untouched');

  // an entity read
  const one = JSON.parse(await w.get(`/v1/world/entities/${id('diary')}`)) as { entity: { state?: Record<string, unknown> } };
  assert.equal(one.entity.state?.text, undefined); assert.equal(one.entity.state?.textBy, undefined);
  assert.ok((await w.get(`/v1/world/entities/${id('guestbook')}`)).includes(`guestbook: ${SECRET}`));

  // the viewers' world-diff
  const sent = JSON.stringify(w.viewers);
  assert.ok(w.viewers.some((m) => m.kind === 'world-diff' && m.diff.upserts.some((e) => e.id === id('diary'))), 'the write reached viewers');
  assert.ok(!sent.includes(`diary: ${SECRET}`), 'no private words in the viewers\' diff');
  assert.ok(!sent.includes(`den-book: ${SECRET}`), 'no nested private words in the viewers\' diff');

  // the god's own stream and snapshot keep them
  assert.ok(JSON.stringify(w.godEvents).includes(`diary: ${SECRET}`), 'the god stream keeps the words');
  assert.ok((await w.get('/v1/god/snapshot', w.token)).includes(`diary: ${SECRET}`), 'the god snapshot keeps the words');
});
