// #1755: the live picture's changes, pushed. A fake ledger (no world): seq and resume, the whole picture on a gap, the
// hash a client checks, nothing in a secret outline on any floor, and no work while nobody holds the push.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LIVE_RING} from './live.ts';
import {fakeLiveWorld as fakeWorld} from './live-testing.ts';
import {canon, liveDelta, liveHash, type LivePicture} from './live-delta.ts';

/** A client's copy, kept by the frames alone, exactly as tools/world-launcher/soul/live.mjs applies them. */
function follow(hub: ReturnType<typeof fakeWorld>['hub'], after: string | null = null) {
  const got: {event: string; data: any}[] = [];
  let copy: any = null;
  const apply = (event: string, data: any) => {
    got.push({event, data});
    if (event === 'live.full') { copy = data; return; }
    if (data.check || !copy) return;   // (a resumed follower here records frames only)
    assert.equal(data.base, copy.seq, 'a change applies on the seq the copy holds');
    const souls = new Map(copy.souls.map((r: any) => [r.id, r]));
    for (const id of data.souls?.del ?? []) souls.delete(id);
    for (const r of data.souls?.set ?? []) souls.set(r.id, r);
    const things = {...copy.things};
    for (const id of data.things?.del ?? []) delete things[id];
    Object.assign(things, data.things?.set ?? {});
    copy = {...copy, seq: data.seq, tick: data.tick, ...(data.catalog !== undefined ? {catalog: data.catalog} : {}), ...(copy.things || data.things ? {things} : {}), ...(data.thingsMore !== undefined ? {thingsMore: data.thingsMore} : {}), souls: [...souls.values()].sort((a: any, b: any) => a.id < b.id ? -1 : 1), speech: [...copy.speech, ...(data.speech ?? [])]};
  };
  const stop = hub.subscribe(after, (event, data) => apply(event, JSON.parse(data)));
  return {got, stop, copy: () => copy};
}

test('a change is one frame on the seq before it; the clock moving alone sends nothing', async () => {
  const w = fakeWorld(), c = follow(w.hub);
  assert.equal(c.got[0]!.event, 'live.full'); assert.equal(c.got[0]!.data.seq, 1);
  w.advance(); await w.get();
  assert.equal(c.got.length, 1, 'nothing changed but the tick: no frame');
  w.entities.h_a!.pose.p = [5, 0, 5]; w.advance(); await w.get();
  assert.equal(c.got.length, 2); assert.deepEqual(c.got[1]!.data.souls, {set: [{id: 's_a', name: 'Ada', at: [5, 5], place: 'g-yard', doing: null}], del: []});
  w.say('s_b', 'sp_1', 'hello'); await w.get();
  assert.deepEqual(c.got[2]!.data.speech.map((l: any) => l.text), ['hello']);
  assert.equal(liveHash(c.copy()), liveHash(await w.get()), 'the copy kept by frames hashes as the world does');
  c.stop(); w.hub.close();
});

test('a client that comes back gets only what it missed; one too far behind or from another epoch gets the whole picture', async () => {
  const w = fakeWorld(), first = follow(w.hub), at = `${first.got[0]!.data.epoch}:${first.got[0]!.data.seq}`;
  first.stop();
  for (let i = 0; i < 3; i++) { w.entities.h_b!.pose.p = [60 + i, 0, 60]; w.advance(); await w.get(); }
  const back = follow(w.hub, at);
  assert.deepEqual(back.got.map(g => [g.event, g.data.seq]), [['live', 2], ['live', 3], ['live', 4]], 'each missed change once, in order');
  back.stop();
  const fresh = follow(w.hub, `${first.got[0]!.data.epoch}:4`); assert.equal(fresh.got.length, 0, 'current: nothing to send'); fresh.stop();
  const other = follow(w.hub, 'zzz:3'); assert.equal(other.got[0]!.event, 'live.full', 'another epoch (a restarted world): the whole picture'); other.stop();
  for (let i = 0; i < LIVE_RING + 5; i++) { w.entities.h_b!.pose.p = [i % 2 ? 70 : 71, 0, 60 + i / 10]; w.advance(); await w.get(); }
  const late = follow(w.hub, at); assert.deepEqual(late.got.map(g => g.event), ['live.full'], 'past the ring: the whole picture'); late.stop();
  w.hub.close();
});

test('nothing inside a secret outline is pushed, on any floor: where a Soul is, and what is said there', async () => {
  const w = fakeWorld(), c = follow(w.hub);
  w.entities.h_a!.pose.p = [25, 0, 25]; w.advance(); await w.get();   // under the attic, standing in the yard
  assert.deepEqual(c.got.at(-1)!.data.souls.set[0], {id: 's_a', name: 'Ada', at: [25, 25], place: 'g-yard', doing: null});
  w.secret('g-attic', true); await w.get();
  const row = c.got.at(-1)!.data.souls.set[0];
  assert.deepEqual(row, {id: 's_a', name: 'Ada', at: null, place: null, doing: null}, 'a secret room upstairs hides who stands under it');
  w.say('s_a', 'sp_2', 'under the attic'); w.say('s_b', 'sp_3', 'out in the open'); w.advance(); await w.get();
  const said = c.got.flatMap(g => g.data.speech ?? []).map((l: any) => l.text);
  assert.deepEqual(said, ['out in the open']);
  assert.ok(!JSON.stringify(c.got).includes('g-attic'), 'the secret place is never named');
  assert.ok(!JSON.stringify(await w.get()).includes('under the attic'));
  c.stop(); w.hub.close();
});

test('a thing\'s state is pushed; one inside a secret outline, on any floor, is deleted and never sent again (A7)', async () => {
  const w = fakeWorld();
  w.setThing('e_lamp', {on: true}); w.setThing('e_door', {open: true});
  const c = follow(w.hub);
  assert.deepEqual(c.got[0]!.data.things, {e_door: {open: true}, e_lamp: {on: true}}, 'both things in the whole picture');
  w.secret('g-attic', true); await w.get();
  const from = c.got.length - 1, at = `${c.got[0]!.data.epoch}:${c.got[from]!.data.seq}`;
  assert.deepEqual(c.got[from]!.data.things, {set: {}, del: ['e_lamp']}, 'the lamp under the secret room upstairs is deleted');
  w.setThing('e_lamp', {on: false}); w.advance(); await w.get();
  assert.equal(c.got.length, from + 1, 'a hidden thing\'s change sends nothing');
  w.entities.e_door!.pose.p = [22, 0, 22]; w.advance(); await w.get();   // carried under the attic
  assert.deepEqual(c.got.at(-1)!.data.things, {set: {}, del: ['e_door']});
  const back = follow(w.hub, at);
  assert.deepEqual(back.got.map(g => g.event), ['live'], 'a client coming back is replayed the door\'s deletion');
  const after = JSON.stringify([...c.got.slice(from), ...back.got, follow(w.hub).got, await w.get()]);
  assert.ok(!after.includes('"e_lamp":') && !after.includes('"e_door":'), 'no frame, replay, whole picture or GET carries a hidden thing\'s state');
  assert.deepEqual(c.copy().things, {}, 'the copy kept by frames holds neither');
  assert.equal(liveHash(c.copy()), liveHash(await w.get()));
  back.stop(); c.stop(); w.hub.close();
});

test('a thing\'s change and a redrawn secret outline are sent at once, not at the next tick bucket (a slow or paused clock)', async () => {
  const w = fakeWorld(), c = follow(w.hub);
  w.setThing('e_door', {open: true}); await w.get();   // no tick: the clock is paused
  assert.deepEqual(c.got.at(-1)!.data.things, {set: {e_door: {open: true}}, del: []}, 'a thing\'s change is pushed without the clock moving');
  assert.deepEqual((await w.get()).things, {e_door: {open: true}}, 'and GET carries it');
  w.secret('g-attic', true); await w.get();
  const n = c.got.length;
  w.reshape('g-attic', [[0, 0], [10, 0], [10, 10], [0, 10]]); await w.get();   // the secret room now covers the yard: Ada and the door
  assert.equal(c.got.length, n + 1, 'one frame, still without the clock moving');
  assert.deepEqual(c.got.at(-1)!.data.things, {set: {}, del: ['e_door']});
  assert.deepEqual(c.got.at(-1)!.data.souls.set, [{id: 's_a', name: 'Ada', at: null, place: null, doing: null}]);
  const pic = JSON.stringify(await w.get()); assert.ok(!pic.includes('"e_door":') && !pic.includes('[1,1]'), 'GET withholds both at once');
  c.stop(); w.hub.close();
});

test('the push runs only while someone holds it', async () => {
  const w = fakeWorld();
  assert.equal(w.hub.subscribers(), 0);
  const a = follow(w.hub), b = follow(w.hub);
  assert.equal(w.hub.subscribers(), 2);
  w.entities.h_a!.pose.p = [3, 0, 3]; w.advance(); await w.get();
  assert.equal(a.got.at(-1)!.data.seq, b.got.at(-1)!.data.seq);
  a.stop(); b.stop(); assert.equal(w.hub.subscribers(), 0);
  w.hub.close();
});

test('canon and the delta: same picture, same bytes; a removed Soul is a deletion', () => {
  assert.equal(canon({b: 1, a: [2, {d: 1, c: null}]}), '{"a":[2,{"c":null,"d":1}],"b":1}');
  const a: LivePicture = {catalog: 'x', tick: 1, at: 1, souls: [{id: 's_a'}, {id: 's_b'}], speech: [], things: {e_1: {on: true}}};
  const b: LivePicture = {catalog: 'y', tick: 2, at: 2, souls: [{id: 's_b'}], speech: [], things: {e_2: {open: true}}};
  assert.deepEqual(liveDelta(a, b, 5), {seq: 5, base: 4, tick: 2, at: 2, catalog: 'y', souls: {set: [], del: ['s_a']}, things: {set: {e_2: {open: true}}, del: ['e_1']}});
  assert.equal(liveDelta(a, {...a, tick: 9, at: 9}, 2), null);
});

test('over the event stream: `live=1` adds the picture to the Soul\'s own stream, resumes by seq, and leaves its cursor alone', async () => {
  const {eventsFixture, readSSE} = await import('../events/testing.ts');
  const w = fakeWorld(), f = eventsFixture(['Roger'], {events: {live: w.hub}}), auth = {authorization: `Bearer ${f.id('Roger')}`};
  try {
    const ac = new AbortController();
    const first = await readSSE(await f.app.request('/v1/edge/events?pad=0&kinds=speech.to-me&live=1', {headers: auth, signal: ac.signal}), m => m.some(x => x.event === 'live.full'), 3000);
    assert.equal(first[0]!.event, 'hello'); assert.equal(first[0]!.data.live, true);
    const full = first.find(x => x.event === 'live.full')!;
    assert.equal(full.id, undefined, 'a live frame carries no SSE id: the Soul\'s cursor is its own');
    assert.equal(full.data.contract, 'soul-live/1'); assert.equal(full.data.seq, 1);
    ac.abort();
    w.entities.h_a!.pose.p = [7, 0, 7]; w.advance(); await w.get();
    const back = await readSSE(await f.app.request(`/v1/edge/events?pad=0&kinds=speech.to-me&live=1&liveAfter=${full.data.epoch}:1`, {headers: auth}), m => m.some(x => x.event === 'live'), 3000);
    const changes = back.filter(x => x.event === 'live');
    assert.deepEqual(changes.map(x => [x.data.base, x.data.seq]), [[1, 2]]); assert.ok(!back.some(x => x.event === 'live.full'));
    const plain = await readSSE(await f.app.request('/v1/edge/events?pad=0&kinds=speech.to-me', {headers: auth}), m => m.some(x => x.event === 'hello'), 1000);
    assert.equal(plain[0]!.data.live, undefined, 'without live=1 the stream is as before');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.hub.subscribers(), 0, 'a closed stream leaves the push');
  } finally { w.hub.close(); f.destroy(); }
});

test('a client coming back after a place was made secret takes the whole picture as it is now, never the kept changes', async () => {
  const w = fakeWorld(), first = follow(w.hub), at = `${first.got[0]!.data.epoch}:${first.got[0]!.data.seq}`;
  first.stop();
  w.say('s_a', 'sp_k', 'the key is under the mat'); w.advance(); await w.get();   // said in the yard (s_a stands there)
  w.secret('g-yard', true); await w.get();
  const back = follow(w.hub, at);
  assert.deepEqual(back.got.map(g => g.event), ['live.full']);
  assert.ok(!JSON.stringify(back.got).includes('under the mat'), 'a kept change from before the place was made secret is not replayed');
  back.stop(); w.hub.close();
});

test('more changes missed than a replay holds are sent as the whole picture', async () => {
  const {LIVE_REPLAY_MAX} = await import('./live.ts');
  const w = fakeWorld(), first = follow(w.hub), at = `${first.got[0]!.data.epoch}:${first.got[0]!.data.seq}`;
  first.stop();
  for (let i = 0; i <= LIVE_REPLAY_MAX; i++) { w.entities.h_b!.pose.p = [60 + (i % 2), 0, 60 + i / 10]; w.advance(); await w.get(); }
  const back = follow(w.hub, at);
  assert.deepEqual(back.got.map(g => g.event), ['live.full']);
  back.stop(); w.hub.close();
});

test('a client that stops reading gets nothing past its backlog, then the whole picture, and no change ahead of it', async () => {
  const {eventsFixture, readSSE} = await import('../events/testing.ts');
  const {LIVE_BACKLOG} = await import('../events/index.ts');
  const w = fakeWorld(), f = eventsFixture(['Roger'], {events: {live: w.hub}});
  try {
    const res = await f.app.request('/v1/edge/events?pad=0&kinds=speech.to-me&live=1', {headers: {authorization: `Bearer ${f.id('Roger')}`}});
    // nobody reads the body: far more changes than a backlog holds
    for (let i = 0; i < LIVE_BACKLOG * 2; i++) { w.entities.h_b!.pose.p = [60 + (i % 2), 0, 60 + i / 10]; w.advance(); await w.get(); }
    const head = JSON.parse(await (await w.app.request('/v1/edge/live')).text()).seq;
    const msgs = await readSSE(res, m => { const full = m.filter(x => x.event === 'live.full'); return full.length >= 2 && m.at(-1)?.data?.seq >= head; }, 5000);
    const live = msgs.filter(x => x.event === 'live' || x.event === 'live.full');
    assert.ok(live.filter(x => x.event === 'live.full').length >= 2, 'the stalled stream fell behind and was sent the whole picture');
    assert.ok(live.filter(x => x.event === 'live').length <= LIVE_BACKLOG, 'no more changes than the backlog');
    // applied as a client would: every change after a whole picture is on the seq before it
    let seq = 0;
    for (const x of live) {
      if (x.event === 'live.full') { seq = x.data.seq; continue; }
      if (x.data.check || x.data.seq <= seq) continue;
      assert.equal(x.data.base, seq, `change ${x.data.seq} follows ${seq}`); seq = x.data.seq;
    }
    assert.equal(seq, head, 'the copy ends current');
  } finally { w.hub.close(); f.destroy(); }
});
