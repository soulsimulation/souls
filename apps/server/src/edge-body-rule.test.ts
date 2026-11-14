// wind-down/1 (#2295): silent for an hour, walks out, sleeps until its agent acts. The rule on a small synthetic world
// (a fake port, the real log table): its ticks, its goals, its rebuild from the log and its bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BodyRule, BODY_KNOBS, type BodyPort, type BodySoul, type BodyKnobs, type Posture} from './edge/ledger/body-rule.ts';

type Move = {tick: number; soulId: string; option: string; steps: {verb: string; params: Record<string, unknown>}[]};
/** A 10 m house at the town's centre; shuffling at 0.6 m/s; a walk that is `stuck` never ends by itself. */
function world(db = new DatabaseSync(':memory:'), opts: {knobs?: Partial<BodyKnobs>; stuck?: boolean} = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS events (world_id TEXT NOT NULL, seq INTEGER NOT NULL, tick INTEGER NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (world_id, seq))');
  const souls: BodySoul[] = [{soulId: 's_ana', entityId: 'e_ana', name: 'Ana', owner: 'o1'}, {soulId: 's_ben', entityId: 'e_ben', name: 'Ben', owner: 'o2'}];
  const body = new Map<string, {x: number; z: number; posture: Posture; until: number | null; to: [number, number] | null}>([
    ['e_ana', {x: 2, z: 1, posture: 'standing', until: null, to: null}], ['e_ben', {x: -1, z: -2, posture: 'standing', until: null, to: null}]]);
  const moves: Move[] = []; let now = 0;
  const seq = () => ((db.prepare('SELECT MAX(seq) n FROM events').get() as {n: number | null}).n ?? 0) + 1;
  const log = (kind: string, payload: object) => {const e = {tick: now + 1, kind, payload}; db.prepare("INSERT INTO events VALUES ('w',?,?,?,?,?,0)").run(seq(), e.tick, kind, 'x', JSON.stringify(payload)); return e;};
  const port: BodyPort = {
    souls: () => souls, pose: id => {const b = body.get(id)!; return {x: b.x, z: b.z, level: 0};}, posture: id => body.get(id)!.posture,
    busy: () => false, running: id => body.get(id)!.until !== null, dry: x => x > -60, clear: () => true,
    places: (x, z) => Math.abs(x) < 5 && Math.abs(z) < 5 ? 'house' : '', centre: () => [0, 0],
    decide: (s, option, _l, steps, windDown) => {
      moves.push({tick: now, soulId: s.soulId, option, steps: steps as Move['steps']}); log('decision', {soulId: s.soulId, trigger: 'edge-body', windDown});
      const b = body.get(s.entityId)!, walk = steps.find(x => x.verb === 'walk_to'), nap = steps.find(x => x.verb === 'mars:pose_v1');
      if (walk) {const to = walk.params.to as [number, number]; b.to = to; b.posture = 'moving'; b.until = opts.stuck ? Infinity : now + Math.ceil(Math.hypot(to[0] - b.x, to[1] - b.z) / 0.6 * 20);}
      else if (nap) {b.posture = 'lying'; b.until = null;} else {b.posture = 'standing'; b.until = null;}
    },
    stop: s => {const b = body.get(s.entityId)!; b.until = null; b.posture = 'standing';},
    publish: () => {}, wallMs: t => t * 50,
  };
  const rule = new BodyRule(db as never, 'w', port, {knobs: opts.knobs});
  const advance = (r: BodyRule, to: number) => {for (; now < to; now++) {
    for (const b of body.values()) if (b.until !== null && now >= b.until) {[b.x, b.z] = b.to!; b.until = null; b.posture = 'standing';}
    r.tick(now);
  }};
  const act = (r: BodyRule, soulId: string, reflex = false) => r.applied(log('decision', {soulId, trigger: 'edge-act:r_' + now, ...(reflex ? {reflex: true} : {})}));
  return {db, rule, port, body, moves, advance, act, at: () => now, set: (t: number) => {now = t;}};
}
const K = BODY_KNOBS;

test('A1 A4c: an Owned Soul gets nothing for an hour after its act; then Wander, the walk out and sleep, each on the tick nextMoveTick named', () => {
  const w = world();
  w.advance(w.rule, 100); w.act(w.rule, 's_ana'); w.act(w.rule, 's_ben'); const last = w.at() + 1;
  assert.equal(w.rule.nextMoveTick(), last + K.wanderTicks);
  w.advance(w.rule, last + K.wanderTicks);
  assert.equal(w.moves.length, 0, 'nothing issued in the Owned hour, connected or not');
  for (let guard = 0; w.rule.nextMoveTick() !== null && guard < 200; guard++) {
    const due = w.rule.nextMoveTick()!, n = w.moves.length; w.advance(w.rule, due + 1);
    assert.ok(w.moves.slice(n).every(m => m.tick === due), 'every move lands on the tick nextMoveTick named');
  }
  assert.equal(w.rule.nextMoveTick(), null, 'both asleep: nothing due');
  for (const id of ['s_ana', 's_ben']) {
    const mine = w.moves.filter(m => m.soulId === id), start = mine[0].tick, asleep = mine.at(-1)!;
    assert.equal(start, last + K.wanderTicks, 'Wander starts an hour after the last act');
    assert.equal(mine[0].steps[0].verb, 'stand');
    const legs = mine.filter(m => m.option === 'body:wander-walk');
    assert.ok(legs.length >= 5, `${legs.length} wander legs`);
    for (let i = 1; i < legs.length; i++) {const gap = legs[i].tick - legs[i - 1].tick; assert.ok(gap >= K.legMinTicks && gap <= K.legMaxTicks, `gap ${gap}`);}
    // the walk out starts 30 min into Wander (none when the body already stands on its sleeping spot)
    const zombie = mine.find(m => m.option === 'body:zombie-walk' || m.option === 'body:asleep');
    assert.equal(zombie?.tick, start + K.zombieTicks, 'the walk out starts 30 min into Wander');
    assert.equal(asleep.option, 'body:asleep'); assert.deepEqual(asleep.steps.at(-1)!.params, {activity: 'nap', seconds: 3600, endless: true});
    assert.ok(asleep.tick - start <= K.boundTicks, `A4b: Wander to asleep in ${asleep.tick - start} ticks`);
    assert.equal(w.rule.view(id)?.state, 'asleep');
  }
  const [a, b] = ['e_ana', 'e_ben'].map(e => w.body.get(e)!);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= K.spotGapM, 'the sleeping spots are 3 m apart');
  for (const s of [a, b]) {assert.equal(w.port.places(s.x, s.z, 0), '', 'outside the built area'); assert.equal(s.posture, 'lying');}
});

test('wander legs end farther from the town centre than they start', () => {
  const w = world(); w.act(w.rule, 's_ana'); w.advance(w.rule, K.wanderTicks + K.zombieTicks);
  let checked = 0;
  for (const m of w.moves.filter(m => m.option === 'body:wander-walk')) {
    const to = m.steps[0].params.to as [number, number], from = w.moves.filter(x => x.soulId === m.soulId && x.tick < m.tick && x.steps[0].verb === 'walk_to').at(-1)?.steps[0].params.to as [number, number] | undefined;
    if (from) {assert.ok(Math.hypot(...to) > Math.hypot(...from)); checked++;}
    assert.equal(m.steps[0].params.pace, 'shuffle');
  }
  assert.ok(checked >= 4);
});

test('A6: after the last Soul is asleep, 24 h of ticks log no decision and move no body', () => {
  const w = world(); w.act(w.rule, 's_ana'); w.act(w.rule, 's_ben');
  w.advance(w.rule, K.wanderTicks + K.boundTicks + 10); assert.equal(w.rule.nextMoveTick(), null);
  const n = w.moves.length, at = [...w.body.values()].map(b => [b.x, b.z]);
  w.advance(w.rule, w.at() + 24 * 72_000);
  assert.equal(w.moves.length, n); assert.deepEqual([...w.body.values()].map(b => [b.x, b.z]), at);
});

test('A4b: a walk out that never arrives is stopped and the body sleeps where it stands, within the bound', () => {
  const w = world(undefined, {stuck: true}); w.act(w.rule, 's_ana'); const start = K.wanderTicks + 1;
  w.advance(w.rule, start + K.boundTicks + 1);
  const asleep = w.moves.filter(m => m.soulId === 's_ana').at(-1)!;
  assert.equal(asleep.option, 'body:asleep'); assert.ok(asleep.tick - start <= K.boundTicks, `${asleep.tick - start}`);
});

test('an agent act wakes a sleeper at once; a reflex act does not restart the hour', () => {
  const w = world(); w.act(w.rule, 's_ana'); w.act(w.rule, 's_ben'); w.advance(w.rule, K.wanderTicks - 10);
  w.act(w.rule, 's_ana', true); w.act(w.rule, 's_ben', true); assert.equal(w.rule.nextMoveTick(), K.wanderTicks + 1, 'reflex: the hour runs on');
  w.advance(w.rule, K.wanderTicks + K.boundTicks + 10); assert.equal(w.rule.view('s_ana')?.state, 'asleep');
  w.act(w.rule, 's_ana'); assert.equal(w.rule.view('s_ana')?.state, 'awake'); assert.equal(w.rule.nextMoveTick(), w.at() + 1 + K.wanderTicks);
});

test('A3: delete the cache, boot from the log, and the next move lands on the same tick with the same goal', () => {
  for (const cut of [K.wanderTicks + 5000, K.wanderTicks + K.zombieTicks + 30]) {
    const control = world(); control.act(control.rule, 's_ana'); control.act(control.rule, 's_ben');
    control.advance(control.rule, K.wanderTicks + K.boundTicks + 10);
    const copy = world(); copy.act(copy.rule, 's_ana'); copy.act(copy.rule, 's_ben'); copy.advance(copy.rule, cut);
    copy.db.exec('DELETE FROM edge_body_v1');
    const rebooted = new BodyRule(copy.db as never, 'w', copy.port);
    copy.advance(rebooted, K.wanderTicks + K.boundTicks + 10);
    assert.deepEqual(copy.moves, control.moves, `booted from the log at tick ${cut}`);
  }
});

test('A3: staggered agents, a restart between the two walk-outs without the cache: the same spots, ticks and goals', () => {
  const end = 20_000 + K.wanderTicks + K.boundTicks + 10, mid = 20_000 + K.wanderTicks + K.zombieTicks - 50;   // Ana asleep, Ben not yet walking out
  const run = (cut: number | null) => {
    const w = world(); w.act(w.rule, 's_ana'); w.advance(w.rule, 20_000); w.act(w.rule, 's_ben');
    // Ben starts where Ana will sleep: his search must still keep 3 m from her spot after the restart
    let r = w.rule; if (cut !== null) {w.advance(r, cut); w.db.exec('DELETE FROM edge_body_v1'); r = new BodyRule(w.db as never, 'w', w.port);}
    w.advance(r, 20_001 + K.wanderTicks + K.zombieTicks - 1);
    const ana = w.body.get('e_ana')!, ben = w.body.get('e_ben')!; ben.x = ana.x + 0.5; ben.z = ana.z; ben.until = null; ben.posture = 'standing';
    w.advance(r, end); return {moves: w.moves, at: [...w.body.values()].map(b => [b.x, b.z])};
  };
  const control = run(null), copy = run(mid);
  assert.deepEqual(copy, control);
  const [a, b] = control.at; assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) >= K.spotGapM);
});

test('A3: a refused wander start (nothing logged) leaves the schedule to the last act: a boot without the cache keeps it', () => {
  const run = (cut: number | null) => {
    const w = world(); const decide = w.port.decide; let refused = 0;
    w.port.decide = (...a) => {if (a[1] === 'body:wander' && !refused++) return; decide(...a);};   // the guard refuses the first stand
    w.act(w.rule, 's_ana'); w.act(w.rule, 's_ben'); let r = w.rule;
    if (cut !== null) {w.advance(r, cut); w.db.exec('DELETE FROM edge_body_v1'); r = new BodyRule(w.db as never, 'w', w.port);}
    w.advance(r, K.wanderTicks + K.boundTicks + 10); return w.moves;
  };
  assert.deepEqual(run(K.wanderTicks + 3000), run(null));
});

test('A4c: a Soul that leaves the world (travel, retirement) is no longer due; nextMoveTick never names a past tick', () => {
  const w = world(); w.act(w.rule, 's_ana'); w.act(w.rule, 's_ben');
  const all = w.port.souls(); w.port.souls = () => all.filter(s => s.soulId !== 's_ben');
  w.advance(w.rule, K.wanderTicks + K.boundTicks + 10);
  assert.equal(w.rule.nextMoveTick(), null); assert.ok(w.moves.every(m => m.soulId === 's_ana'));
});

test('a body that cannot lie down (rolling) sleeps where it stands: no nap is issued', () => {
  const w = world(); w.port.upright = () => true; w.act(w.rule, 's_ana'); w.act(w.rule, 's_ben');
  w.advance(w.rule, K.wanderTicks + K.boundTicks + 10);
  assert.deepEqual(['s_ana', 's_ben'].map(id => w.rule.view(id)?.state), ['asleep', 'asleep']);
  assert.ok(!w.moves.some(m => m.option === 'body:asleep')); assert.equal(w.rule.view('s_ana')?.doing, 'standing');
});

test('A2: no wall clock: the same moves whatever Date.now says', t => {
  const run = () => {const w = world(); w.act(w.rule, 's_ana'); w.advance(w.rule, K.wanderTicks + K.boundTicks); return w.moves;};
  const a = run(); t.mock.method(Date, 'now', () => Math.random() * 1e13); assert.deepEqual(run(), a);
});

test('A7: a Soul the old rule held idle, zombie or asleep enters Wander at its first tick under the new rule', () => {
  for (const state of ['idle', 'zombie', 'asleep']) {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE edge_body_v1 (world_id TEXT NOT NULL, soul_id TEXT NOT NULL, state TEXT NOT NULL, doing TEXT, since INTEGER NOT NULL,
      anchor_x REAL, anchor_z REAL, last_act INTEGER NOT NULL, poke_at INTEGER NOT NULL, woke_at INTEGER NOT NULL, busy_at INTEGER NOT NULL,
      idle_from INTEGER NOT NULL, next_at INTEGER NOT NULL, n INTEGER NOT NULL, knobs TEXT, PRIMARY KEY (world_id, soul_id)) WITHOUT ROWID`);
    db.prepare("INSERT INTO edge_body_v1 VALUES ('w','s_ana',?,NULL,1,NULL,NULL,1,0,1,0,1,1,0,NULL)").run(state);
    const w = world(db); w.set(500); w.advance(w.rule, 501);
    assert.deepEqual(w.moves.map(m => [m.tick, m.soulId, m.option]), [[500, 's_ana', 'body:wander']], state);
  }
});

test('the knobs are injectable: a short wind-down for tests and clips', () => {
  const w = world(undefined, {knobs: {wanderTicks: 200, zombieTicks: 400, legMinTicks: 100, legMaxTicks: 150, boundTicks: 1500}});
  w.act(w.rule, 's_ana'); w.advance(w.rule, 2000);
  assert.equal(w.rule.view('s_ana')?.state, 'asleep');
  assert.equal(w.moves.find(m => m.soulId === 's_ana')?.tick, 201);
});
