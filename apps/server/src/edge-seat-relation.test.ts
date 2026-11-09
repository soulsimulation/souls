// #848: a seat named with a relation word between it and its place ("the bench outside the cottage", "the audience bench
// inside the presentation hall") is found like "by"/"in" phrasings; `outside` stays a constraint (read as `outdoor`).
import test from 'node:test';
import assert from 'node:assert/strict';
import {accept, invite} from '../test/native-owner-fixture.ts';
import {bootEden} from '../test/eden-capabilities-timing.ts';

test('#848: "outside"/"inside" name the right seat on hello-hamlet, and "outside" is still a constraint', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(w.close);
  const act = async (words: string) => await accept(w.host, w.edge.act(w.soul, {capability: words})) as any;
  const named = (r: any) => (r.did_you_mean ?? []).map((d: any) => d.id);
  // A1: the S3 demonstration 3 request names the cottage's outdoor bench. #849: resolve says so, once; an act on the words still
  // asks for the id, and the id sits her there
  const dry = (words: string) => w.edge.intents.dryRun(w.soul, {capability: words}) as any;
  for (const words of ['sit on the bench outside the cottage', 'sit on the bench by the cottage']) {
    const r = dry(words); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.would.capability, 'sit:cottage/part-outdoor-bench');
    const acted = await act(words); assert.equal(acted.code, 'capability.choose', JSON.stringify(acted)); assert.deepEqual(named(acted), ['sit:cottage/part-outdoor-bench'], 'one seat, listed once');
  }
  for (const words of ['sit on the audeince', 'sit on the outdor']) assert.equal((await act(words)).accepted, false, `${words}: a misspelt word takes no seat either`);
  assert.equal((await act('sit:cottage/part-outdoor-bench')).accepted, true);
  // A2: `inside` reads as `in`
  const inside = await act('sit on the audience bench inside the presentation hall'), inHall = await act('sit on the audience bench in the presentation hall');
  assert.deepEqual(named(inside), ['sit:lab-presentation-hall/part-audience'], JSON.stringify(inside)); assert.deepEqual(named(inside), named(inHall));
  // A3: the hall has no outdoor seat, so "outside the presentation hall" names none; an unknown seat names none
  for (const words of ['sit on the bench outside the presentation hall', 'sit on the hammock outside the cottage']) {
    const r = await act(words); assert.equal(r.accepted, false, words); assert.deepEqual(named(r), [], `${words}: ${JSON.stringify(r)}`);
  }
});

// Review of 98ccb03e and d00ed59b: a relation word that does not lead to a named seat keeps its old handling (A6), on
// hello-hamlet and eden-2026.
test('#848: "outside" that names no seat (bare, trailing, "with Bo", "now") answers as it does without the relation', {timeout: 300000}, async t => {
  // #1152 reads "outside" as the part's "outdoor", so these aren't unknown words any more; the relation reading must not change them
  const hamlet = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(hamlet.close);
  const outdoors = await accept(hamlet.host, hamlet.edge.act(hamlet.soul, {capability: 'sit outdoors'})) as any;
  assert.equal(outdoors.accepted, true, JSON.stringify(outdoors)); assert.equal(outdoors.receipt?.capability ?? outdoors.resolved, 'sit:cottage/part-outdoor-bench');
  const answers = async (w: typeof hamlet, table: [string, string][]) => { for (const [words, code] of table) { const r = await accept(w.host, w.edge.act(w.soul, {capability: words})) as any; assert.equal(r.code, code, `${words}: ${JSON.stringify(r).slice(0, 300)}`); } };
  await answers(hamlet, [['sit outside', 'capability.choose'], ['sit outside with Bo', 'capability.choose'], ['sit outside now', 'capability.unavailable'], ['sit down outside for a minute', 'capability.unavailable'], ['sit outside here', 'capability.unavailable']]);
  const eden = await bootEden(); t.after(eden.close);
  await answers(eden, [['sit outside', 'capability.unavailable'], ['sit outdoors', 'capability.unknown'], ['sit outside with Bo', 'capability.unavailable'], ['sit outside now', 'capability.unavailable'], ['sit down outside for a minute', 'capability.unavailable']]);
});

// #1242: "sit outside with Bo" with nobody called Bo to invite names the outdoor bench, chooses nothing and says who was not
// found; with Bo in the world the same words invite Bo, as before (together/1)
test('#1242: a missing companion leaves the seat words a choice and is named; a present one is invited as before', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(w.close);
  const dry = (words: string) => w.edge.intents.dryRun(w.soul, {capability: words}) as any;
  for (const [words, who] of [['sit outside with Bo', 'Bo'], ['sit outside with a friend', 'a friend']]) {
    const r = dry(words); assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.code, 'capability.choose', JSON.stringify(r));
    assert.deepEqual(r.did_you_mean.map((d: any) => d.id), ['sit:cottage/part-outdoor-bench'], words);
    assert.deepEqual(r.discovery.unresolved, {with: who}); assert.ok(r.reason.startsWith(`I couldn't find "${who}" here to invite, so nobody was invited.`), r.reason);
  }
  const act = await accept(w.host, w.edge.act(w.soul, {capability: 'sit outside with Bo'})) as any;
  assert.equal(act.accepted, false, 'an act on the words takes no seat'); assert.equal(act.code, 'capability.choose');
  // A3: a place word that names no outdoor seat is still refused, nothing substituted
  for (const words of ['sit outside near the orchard', 'sit on the bench outside the presentation hall with Bo']) {const r = dry(words); assert.equal(r.ok, false, words); assert.deepEqual((r.did_you_mean ?? []).map((d: any) => d.id).filter((id: string) => id.startsWith('sit:')), [], `${words}: ${JSON.stringify(r)}`);}
  await invite(w, 'bo'); await accept(w.host, w.souls.create('dev:bo', {name: 'Bo', description: 'a friend'})); await w.settle(3);
  const known = dry('sit outside with Bo'); assert.equal(known.discovery?.unresolved, undefined, JSON.stringify(known));
  assert.ok(!JSON.stringify(known).includes("couldn't find"), 'a Soul who can be invited is not reported missing');
  const bo = [...w.host.minds.values()].find(m => m.name === 'Bo')!, invited = dry('sit on the outdoor bench with Bo');
  assert.equal(invited.ok, true, JSON.stringify(invited)); assert.equal(invited.would.capability, 'sit:cottage/part-outdoor-bench'); assert.deepEqual(invited.would.params?.with, [bo.soulId], 'the invite still goes with the seat');
  // review blocker: a seat named after the companion is never answered with the ground
  const after = dry('sit with Zed on the outdoor bench'); assert.ok(!(after.did_you_mean ?? []).some((d: any) => d.id === 'sit:here') && after.would?.capability !== 'sit:here', JSON.stringify(after));
});
