import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { conferenceFixtures, conferenceJourney, conferenceFinalization, conferenceBrowserStop, conferenceMeetingStage, conferenceMeetingJourney, proveConferenceCreator, conferenceClearanceTools } from './conference-native-page.mjs';
import { explainConference, rehearsalTemplate } from '../../playtest/conference/rehearse.mjs';
import { drawnLoad, bodyGeometry } from '../../playtest/carry-contact/oracle.mjs';
import { describeThing } from '../../../v2/client/src/creator/thing.mjs';
const THREE = createRequire(new URL('../../../mars/viewer/package.json', import.meta.url))('three');
const clearanceTools = options => conferenceClearanceTools({ vector: () => new THREE.Vector3(), drawnLoad, bodyGeometry, ...options });
function rigidFixture(geometry = new THREE.BoxGeometry(1,1,1)) {
  const scene=new THREE.Scene(),root=new THREE.Group(),mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial());root.add(mesh);scene.add(root);scene.updateMatrixWorld(true);
  return {scene,root,mesh,layer:{drawn:new Map([['lectern',{obj:root}]]),instancer:{pools:new Map()}}};
}
const vertex = p => ({ p, mesh:'actual-skin',index:7 });

test('clearance uses actual instance slot plus mesh-parent transform without applying geometry-local placement twice',()=>{
  const f=rigidFixture(),tools=clearanceTools();f.scene.remove(f.root);
  const parent=new THREE.Group();parent.position.set(3,2,-4);parent.rotation.y=.7;f.scene.add(parent);
  const local=new THREE.Matrix4().makeTranslation(.3,.6,-.2),root=new THREE.Matrix4().makeRotationY(.4).setPosition(1,.5,2);
  const mesh=new THREE.InstancedMesh(f.mesh.geometry,f.mesh.material,2);mesh.count=2;mesh.setMatrixAt(0,new THREE.Matrix4().makeTranslation(100,0,0));mesh.setMatrixAt(1,root.clone().multiply(local));parent.add(mesh);f.scene.updateMatrixWorld(true);
  f.layer.drawn.set('lectern',{inst:'pool',shown:true,obj:f.root});f.layer.instancer.pools.set('pool',{slots:new Map([['lectern',1]]),parts:[{local}],meshes:[mesh]});
  const before=mesh.instanceMatrix.array.slice(),matrix=parent.matrixWorld.clone().multiply(root).multiply(local);
  const inside=new THREE.Vector3().applyMatrix4(matrix).toArray(),result=tools.clearance([vertex(inside)],tools.lectern(f.layer,f.scene,'lectern'));
  assert.equal(result.insideVertices,1);assert.equal(result.worst.part.slot,1);assert(result.worst.distanceM>.49);
  const direct=rigidFixture();direct.root.matrixAutoUpdate=false;direct.root.matrix.copy(matrix);direct.scene.updateMatrixWorld(true);
  const uninstanced=tools.clearance([vertex(inside)],tools.lectern(direct.layer,direct.scene,'lectern'));
  assert.equal(uninstanced.insideVertices,1);assert(Math.abs(uninstanced.worst.distanceM-result.worst.distanceM)<1e-7,'visible-root and actual-instance surfaces agree');
  assert.deepEqual(mesh.instanceMatrix.array,before,'observation never mutates native/drawn transforms');
  f.layer.instancer.pools.get('pool').slots.set('lectern',0);
  assert.equal(tools.clearance([vertex(inside)],tools.lectern(f.layer,f.scene,'lectern')).insideVertices,0,'neighbor instance cannot substitute for this lectern');
});

test('actual production chamfered, merged lectern shells preserve gaps and bevels rather than using their enclosing box',async()=>{
  const {buildKit}=await import('../../../apps/web/src/gen-mesh/kit.mesh.ts');
  const {MaterialLib}=await import('../../../apps/web/src/gen-mesh/materials.ts');
  const template=JSON.parse(readFileSync(new URL('../../../worlds/templates/conference-rehearsal.json',import.meta.url)));
  const args=template.batches.flatMap(b=>b.ops).find(o=>o.op==='define'&&o.def.name==='core-hall_lecture').def.make.args;
  const scene=new THREE.Scene(),root=buildKit(args,{materials:new MaterialLib(),tint:(_key,fallback)=>fallback});scene.add(root);scene.updateMatrixWorld(true);
  const layer={drawn:new Map([['lectern',{obj:root}]]),instancer:{pools:new Map()}},tools=clearanceTools(),load=tools.lectern(layer,scene,'lectern');
  assert.equal(load.parts.length,4,'the real merged mesh has four disconnected closed authored pieces');
  assert.equal(tools.clearance([vertex([.4,.4,0])],load).insideVertices,0,'empty gap inside total bounds stays empty');
  assert.equal(tools.clearance([vertex([0,.64,.1])],load).insideVertices,1,'actual shaft interior is detected');
  const bevel=tools.clearance([vertex([.799,.099,.599])],load);
  assert(bevel.projectedPartOverlaps>0);assert.equal(bevel.insideVertices,0,'outer dais corner is outside its actual bevel');
  const surface=tools.clearance([vertex([0,.1,0])],load);assert.equal(surface.insideVertices,0);assert.equal(surface.surfaceUncertainVertices,1,'surface contact stays uncertain');
});

test('visible bodyDraw sampling honors indexed drawRange/material groups and excludes hidden source primitives',()=>{
  const f=rigidFixture(),root=new THREE.Group(),bone=new THREE.Bone();bone.name='FootL';root.add(bone);f.scene.add(root);
  const g=new THREE.BoxGeometry(1,1,1),count=g.attributes.position.count;
  g.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(count*4),4));
  const weights=new Float32Array(count*4);for(let i=0;i<count;i++)weights[i*4]=1;g.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const mesh=new THREE.SkinnedMesh(g,new THREE.MeshBasicMaterial());mesh.userData.bodyDraw=true;root.add(mesh);mesh.bind(new THREE.Skeleton([bone]));
  const hidden=new THREE.Mesh(new THREE.BoxGeometry(100,100,100),new THREE.MeshBasicMaterial());hidden.visible=false;root.add(hidden);
  g.setDrawRange(0,6);f.scene.updateMatrixWorld(true);const tools=clearanceTools(),points=tools.body(root,f.scene);
  assert.equal(points.length,4);assert(points.every(p=>p.mesh===mesh.uuid&&p.part==='foot'&&p.inferredPart));
  assert(points.every(p=>p.matrix.length===16&&Number.isInteger(p.index)));
  g.setDrawRange(0,12);g.clearGroups();g.addGroup(0,6,0);g.addGroup(6,6,1);mesh.material=[new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial({visible:false})];
  assert.equal(tools.body(root,f.scene).length,4,'hidden material group is not submitted');
  assert.throws(()=>clearanceTools({maxVertices:3}).body(root,f.scene),/vertex limit/);
  mesh.visible=false;assert.throws(()=>tools.body(root,f.scene),/skin unavailable|visibly/);
});

test('clearance fails closed on open, changed, hidden, detached, singular and bounded-work geometry',()=>{
  for(const mutate of [f=>f.mesh.visible=false,f=>f.scene.remove(f.root),f=>f.root.scale.set(0,1,1),f=>f.mesh.geometry.setDrawRange(0,3)]){
    const f=rigidFixture();mutate(f);f.scene.updateMatrixWorld(true);assert.throws(()=>clearanceTools().lectern(f.layer,f.scene,'lectern'));
  }
  const f=rigidFixture(),tools=clearanceTools(),load=tools.lectern(f.layer,f.scene,'lectern');
  f.mesh.geometry.attributes.position.needsUpdate=true;assert.throws(()=>tools.lectern(f.layer,f.scene,'lectern'),/topology changed/);
  assert.throws(()=>clearanceTools({maxTests:1}).clearance([vertex([0,0,0])],load),/work limit/);
  assert.throws(()=>clearanceTools({maxTriangles:1}).lectern(f.layer,f.scene,'lectern'),/geometry limit/);
  assert.throws(()=>tools.clearance([vertex([NaN,0,0])],load),/nonfinite skin/);
  assert.equal(tools.clearance([vertex([0,0,.5])],load).surfaceUncertainVertices,1);
});

test('tracked conference fixture preserves the existing authored layout exactly', () => {
  const eden = JSON.parse(readFileSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)));
  const scene = JSON.parse(readFileSync(new URL('../../../worlds/templates/conference-rehearsal.json', import.meta.url)));
  assert.deepEqual(scene, rehearsalTemplate(eden));
});

test('ambiguous discovery refuses instead of choosing an unrelated lectern', () => {
  const question = { id: 'question' }, benchA = { id: 'left', name: 'audience-left' }, benchB = { id: 'right', name: 'audience-right' };
  const seen = { lecterns: [{ id: 'lectern' }], questions: [question], benches: [benchB, benchA] };
  assert.deepEqual(conferenceFixtures(seen), { lecture: 'lectern', question: 'question', benches: ['left', 'right'] });
  assert.throws(() => conferenceFixtures({ ...seen, lecterns: [...seen.lecterns, { id: 'unrelated' }] }), /one authored presentation lectern/);
  assert.throws(() => conferenceFixtures({ ...seen, benches: [benchA] }), /two authored audience benches/);
});

for (const outcome of [{ answer: 'receipt' }, { answer: 'refused', reason: 'out_of_reach' }]) {
  test(`unrelated terminal ${outcome.reason ?? outcome.answer} is not an interruption`, async () => {
    const calls = []; let polls = 0;
    const done = { ok: true, phase: 'done', receipt: { answers: [{ answer: 'receipt' }] } };
    const speaker = { label: 'Presenter', body: 'body', cli: async (...words) => {
      calls.push(words);
      if (words[0] === 'inspect') return { ok: true, parent: 'lectern' };
      if (words[0] === 'act' && words[1] === 'tell_story' && !words.includes('--wait')) return { ok: true, sequence: 7 };
      if (words[0] === 'receipt') return { ok: true, receipt: { going: ++polls === 1, answers: [polls === 1 ? { answer: 'accepted', at: 123 } : outcome] } };
      return done;
    } };
    await assert.rejects(explainConference({ speaker, lecture: 'lectern', question: 'question', interruptStory: true }), /native refused:left/);
    assert(calls.some(([op, word]) => op === 'act' && word === 'point'));
    assert(!calls.some(([op, word]) => op === 'act' && word === 'clap'));
  });
}

test('an admission refusal cannot masquerade as an observed story start', async () => {
  const calls = [];
  const speaker = { label: 'Presenter', body: 'body', cli: async (...words) => {
    calls.push(words);
    if (words[0] === 'inspect') return { ok: true, parent: 'lectern' };
    if (words[0] === 'receipt') return { ok: true, receipt: { going: false, answers: [{ answer: 'refused', reason: 'out_of_reach' }] } };
    if (!words.includes('--wait')) return { ok: true, sequence: 7 };
    return { ok: true, phase: 'done', receipt: { answers: [{ answer: 'receipt' }] } };
  } };
  await assert.rejects(explainConference({ speaker, lecture: 'lectern', question: 'question', interruptStory: true }), /still be running/);
  assert(!calls.some(([op, word]) => op === 'act' && word === 'point'));
});

test('receipt-only, stale and missing presenter diagnostics cannot qualify a depicted journey', () => {
  const sample = (tick, activity) => ({ tick, dt: .05, renderFrame: tick, souls: [{ id: 'soul', entityId: 'entity' }],
    residents: [{ id: 'soul', body: 'entity', activity }], entities: { entity: {} } });
  assert.throws(() => conferenceJourney([], 'soul'), /samples missing/);
  assert.throws(() => conferenceJourney([sample(1, 'tell-story'), sample(1, 'point')], 'soul'), /clock stale/);
  assert.throws(() => conferenceJourney([{ ...sample(1, 'tell-story'), souls: [] }, sample(2, 'point')], 'soul'), /mapping missing/);
  assert.throws(() => conferenceJourney([sample(1, 'tell-story'), sample(2, 'point'), sample(3, 'clap'), sample(4, 'idle')], 'soul'), /phases not all depicted/);
  const phases = [1, 90, 180, 260].map(t => sample(t, 'tell-story'));
  const valid = [...phases, sample(300, 'point'), sample(320, 'clap'), sample(340, 'idle'), sample(341, 'idle')];
  assert.equal(conferenceJourney(valid, 'soul').phases.length, 3);
  assert.throws(() => conferenceJourney(valid.slice(0, -2), 'soul'), /settled endpoint/);
});

test('render-observer collection is idempotent and a collection error cannot discard action receipts', async () => {
  const scratch = resolve(import.meta.dirname, '../../../.local'); mkdirSync(scratch, { recursive: true });
  const paths = { dir: mkdtempSync(join(scratch, 'conference-finalize-test-')) };
  const state = { rows: [{ words: ['receipt', '7'], answer: { receipt: { answers: [{ answer: 'refused', reason: 'left' }] } } }] };
  let calls = 0;
  conferenceFinalization({ evaluate: async () => {
    calls++;
    assert.deepEqual(JSON.parse(readFileSync(join(paths.dir, 'command-conference-sequence.json'))).rows, state.rows, 'receipts were saved before risky collection');
    throw Error('lost browser context');
  } }, paths, state);
  const first = state.finalizeDraw(), again = state.finalizeDraw();
  assert.equal(first, again, 'rejection is cached, not retried');
  await assert.rejects(first, /lost browser context/);
  await assert.rejects(again, /lost browser context/);
  await assert.rejects(state.finalizeDraw(), /lost browser context/);
  state.finalizationError = 'lost browser context'; state.persistSequence(); state.persistSequence();
  assert.deepEqual(JSON.parse(readFileSync(join(paths.dir, 'command-conference-sequence.json'))).rows, state.rows);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(join(paths.dir, 'command-conference-finalization.json'))).ok, false);
  const goodPaths = { dir: mkdtempSync(join(scratch, 'conference-finalize-test-')) }, good = {};
  conferenceFinalization({ evaluate: async () => { calls++; return { samples: [{ frame: 1 }, { frame: 2 }], failures: [] }; } }, goodPaths, good);
  await good.finalizeDraw(); await good.finalizeDraw();
  assert.equal(calls, 2, 'restored observer is collected once');
  assert.equal(JSON.parse(readFileSync(join(goodPaths.dir, 'command-conference-final-draw.json'))).samples.length, 2);
});

test('the exact serialized browser stop restores hooks once and caches both result and ownership error', () => {
  const previous = globalThis.window; let stops = 0;
  const show = () => {}, original = () => {}, prototype = { show };
  const fixture = () => ({ samples: [{ frame: 1, measurementMs: 1.25 }, { frame: 2, measurementMs: 3 }], failures: [], sampleLimit: 361,
    stopRender() { stops++; }, prototype, show, original, qualification: 'test' });
  try {
    globalThis.window = { __conferenceDrawObserver: fixture() };
    const first = conferenceBrowserStop();
    assert.deepEqual(first.measurementSummary, { count: 2, totalMs: 4.25, maxMs: 3, missing: 0,
      basis: 'retained successful samples; failed callbacks are not timed' });
    assert.deepEqual(first.samples.map(s => s.measurementMs), [1.25, 3], 'individual sample overhead remains available');
    assert.equal(conferenceBrowserStop(), first); assert.equal(prototype.show, original); assert.equal(stops, 1);
    prototype.show = () => {};
    globalThis.window.__conferenceDrawObserver = fixture();
    let failure;
    try { conferenceBrowserStop(); } catch (error) { failure = error; }
    assert.match(failure.message, /ownership changed/);
    assert.throws(conferenceBrowserStop, error => error === failure);
    assert.equal(stops, 2, 'failed browser cleanup is also never repeated');
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('an installed observer cannot disappear between the journey check and final collection', async () => {
  const scratch = resolve(import.meta.dirname, '../../../.local'); mkdirSync(scratch, { recursive: true });
  const paths = { dir: mkdtempSync(join(scratch, 'conference-finalize-test-')) }, state = { observerInstalled: true, rows: [] };
  conferenceFinalization({ evaluate: async () => undefined }, paths, state);
  await assert.rejects(state.finalizeDraw(), /installed observer collection missing/);
  assert.equal(JSON.parse(readFileSync(join(paths.dir, 'command-conference-finalization.json'))).ok, false);
});

const meetingFrame = (tick, activity = 'idle', seated = false) => ({ tick, dt: .05, renderFrame: tick,
  souls: [{ id: 'soul', entityId: 'entity' }], residents: [{ id: 'soul', body: 'entity', activity, activityAge: .3 }],
  entities: { entity: { state: seated ? { baseActivity: 'sit', seatHeight: .465 } : {} } } });
const phase = (stage, start, frames) => {
  const stages = [{ stage: start, soul: 'soul', frameIndex: 0 }, { stage, soul: 'soul', frameIndex: frames.length - 1 }];
  return conferenceMeetingStage(frames, stages, stages[1]);
};

test('audience entry requires an observed standing-to-seat change, not only a terminal seat', () => {
  assert.doesNotThrow(() => phase('attend-done', 'attend-start', [meetingFrame(1), meetingFrame(2, 'walk'), meetingFrame(3, 'sit', true)]));
  assert.throws(() => phase('attend-done', 'attend-start', [meetingFrame(1, 'sit', true), meetingFrame(2, 'sit', true)]), /sit entry not depicted/);
  assert.throws(() => phase('attend-done', 'attend-start', [meetingFrame(1), meetingFrame(1, 'sit', true)]), /clock stale/);
});

test('a seated wave must preserve its underlying seat and visibly return to sitting', () => {
  const frames = [meetingFrame(1, 'sit', true), meetingFrame(2, 'wave', true), meetingFrame(3, 'sit', true), meetingFrame(4, 'sit', true)];
  assert.doesNotThrow(() => phase('seated-wave-done', 'seated-wave-start', frames));
  assert.throws(() => phase('seated-wave-done', 'seated-wave-start', frames.slice(0, -1)), /return not depicted/);
  assert.throws(() => phase('seated-wave-done', 'seated-wave-start', frames.map(f => f.tick === 2 ? meetingFrame(2, 'wave') : f)), /lost underlying seat/);
  assert.throws(() => phase('seated-wave-done', 'seated-wave-start', [...frames.slice(0, 2), meetingFrame(3), meetingFrame(4)]), /return seated/);
});

test('rise and question gates require actual depicted standing and the next ordinary action', () => {
  assert.doesNotThrow(() => phase('rise-done', 'rise-start', [meetingFrame(1, 'sit', true), meetingFrame(2), meetingFrame(3)]));
  assert.throws(() => phase('rise-done', 'rise-start', [meetingFrame(1), meetingFrame(2)]), /rise from seat/);
  assert.doesNotThrow(() => phase('question-posted', 'question-start', [meetingFrame(1), meetingFrame(2, 'operate')]));
  assert.throws(() => phase('question-posted', 'question-start', [meetingFrame(1), meetingFrame(2, 'sit', true)]), /question action not depicted/);
});

test('meeting gate rejects a short journey and incomplete assembly observations', () => {
  assert.throws(() => conferenceMeetingJourney([], [], Array(5).fill({})), /stage coverage incomplete/);
  const counts = { 'attend-done': 8, 'lectern-ready': 2, 'lecture-ready': 2, 'story-complete': 2,
    'seated-wave-done': 1, 'rise-done': 8, point: 1, settled: 1, 'question-posted': 1,
    'question-refused': 1, 'question-recovered': 1, 'introduction-done': 1, 'conference-clean': 1 };
  const stages = Object.entries(counts).flatMap(([stage, count]) => Array.from({ length: count }, () => ({ stage })));
  assert.throws(() => conferenceMeetingJourney([meetingFrame(1), meetingFrame(2)], stages, Array(5).fill({})), /assemblies must be captured/);
});

test('group cleanup rejects a departed actor still seated or a group never seen applauding', () => {
  const stages = [{ stage: 'applause-start', soul: 'soul', frameIndex: 0 }, { stage: 'conference-clean', soul: 'soul', seats: ['soul'], frameIndex: 3 }];
  const frames = [meetingFrame(1, 'clap'), meetingFrame(2, 'clap'), meetingFrame(3), meetingFrame(4)];
  assert.doesNotThrow(() => conferenceMeetingStage(frames, stages, stages[1]));
  assert.throws(() => conferenceMeetingStage([...frames.slice(0, -1), meetingFrame(4, 'sit', true)], stages, stages[1]), /standing rest/);
  assert.throws(() => conferenceMeetingStage(frames.map(f => meetingFrame(f.tick)), stages, stages[1]), /applause not depicted/);
});


function creatorReplies({ names = { 1: 'returned-id' }, readID = 'returned-id', readKind = 'eden:conference_question', readParent = 'actual-ground', readAt = [12, 0, 12], kinds = { 'eden:conference_question@pin': {} }, readback, placeOK = true } = {}) {
  const calls = [];
  return { calls, label: 'Creator', cli: async (...words) => {
    calls.push(words);
    if (words[0] === 'place') return placeOK ? { ok: true, sequence: 23, names } : { ok: false, code: 'edit.overlap' };
    if (words.length > 1) return readback ?? { ok: true, id: readID, kind: readKind, in: [{ id: readParent }], at: readAt };
    return { ok: true, kinds, nodes: [{ id: 'actual-ground', kind: 'eden:ground' }] };
  } };
}

test('creator proof uses the actual discovered kind/ground and returned place identity for readback', async () => {
  const creator = creatorReplies(), result = await proveConferenceCreator({ creator });
  assert.equal(result.id, 'returned-id'); assert.equal(result.sequence, 23);
  assert.equal(result.kind, 'eden:conference_question@pin'); assert.equal(result.readbackKind, 'eden:conference_question');
  assert.match(result.readbackRevision, /unproved.*no revision/);
  assert.deepEqual(creator.calls, [['describe'], ['place', 'eden:conference_question@pin', '--in', 'actual-ground', '--at', '12,0,12'], ['describe', 'returned-id']]);
});

for (const [options, reason] of [[{ names: {} }, /named thing/], [{ readID: 'unrelated-id' }, /returned identity/],
  [{ readKind: 'eden:bench' }, /selected kind/], [{ readKind: 'eden:conference_question_extra' }, /selected kind/],
  [{ readKind: 'eden:conference_question@different-revision' }, /selected kind/], [{ readParent: 'another-ground' }, /another parent/],
  [{ readAt: [11, 0, 12] }, /declared placement/], [{ placeOK: false }, /edit.overlap/]]) {
  test(`creator proof rejects ${reason.source} without another placement`, async () => {
    const creator = creatorReplies(options); await assert.rejects(proveConferenceCreator({ creator }), reason);
    assert.equal(creator.calls.filter(words => words[0] === 'place').length, 1);
  });
}

test('creator proof accepts the ordinary describeThing projection without inventing a readback revision', async () => {
  const kinds = { 'eden:conference_question@pin': { admits: ['thing'] } };
  const readback = describeThing('returned-id', { kinds, nodes: [
    { id: 'actual-ground', kind: 'eden:ground', parent: null },
    { id: 'returned-id', kind: 'eden:conference_question', parent: 'actual-ground', at: [12000, 0, 12000] },
  ] }, {});
  readback.at = readback.at.map(n => n / 1000); // The ordinary creator CLI prints millimetres as metres.
  assert.equal(Object.hasOwn(readback, 'revision'), false);
  const result = await proveConferenceCreator({ creator: creatorReplies({ kinds, readback }) });
  assert.equal(result.kind, 'eden:conference_question@pin'); assert.equal(result.readbackKind, readback.kind);
  assert.match(result.readbackRevision, /unproved/);
});

for (const kinds of [{ 'eden:conference_question@pin': {}, 'eden:conference_question@other': {} }, { 'eden:conference_question': {} }]) {
  test('creator proof refuses ambiguous or unqualified catalogue kinds before placement', async () => {
    const creator = creatorReplies({ kinds });
    await assert.rejects(proveConferenceCreator({ creator }), /unambiguous|qualified kind revision/);
    assert.equal(creator.calls.filter(words => words[0] === 'place').length, 0);
  });
}
