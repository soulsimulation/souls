// Actual-page conference composition diagnostic. Receipts/canvas readiness do not qualify animation/contact.
// The unchanged runOwnedAttempt owns the sole native world, all registered clients/commands and the browser.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeCameraMode } from './camera-native-page.mjs';
import { discoverConference, performConference } from '../../playtest/conference/rehearse.mjs';
import { conferenceWorldPage, downloadConferenceClient, pairConferenceSeat, pairConferenceCreator, requireConferenceRecipe } from '../../playtest/conference/owned-seats.mjs';

const states = new Map();
const names = ['Presenter', 'Cedar', 'Maple', 'Willow', 'Birch'];
const save = (paths, file, value) => writeFileSync(join(paths.dir, file), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });

export function conferenceFixtures({ lecterns, questions, benches }) {
  assert.equal(lecterns.length, 1, 'conference-proof requires one authored presentation lectern');
  assert.equal(questions.length, 1, 'conference-proof requires one authored question stand');
  assert.equal(benches.length, 2, 'conference-proof requires two authored audience benches');
  return { lecture: lecterns[0].id, question: questions[0].id,
    benches: [...benches].sort((a, b) => a.name.localeCompare(b.name)).map(n => n.id) };
}

// Same FNV phase mapping as production activity-poses.ts; this is timing metadata, never a pose input.
export function conferenceObservation(frame, soul) {
  assert(Number.isFinite(frame?.tick) && Number.isFinite(frame.dt) && frame.dt > 0 && Number.isFinite(frame.renderFrame), 'conference depicted clock missing');
  const matches = frame.souls?.filter(s => s.id === soul) ?? [];
  assert.equal(matches.length, 1, 'conference presenter mapping missing or ambiguous');
  const entity = matches[0].entityId, resident = frame.residents?.find(r => r.id === soul && r.body === entity);
  assert(resident && frame.entities?.[entity], 'conference presenter not depicted');
  const partner = frame.entities[entity].state?.partner;
  const phaseID = typeof partner === 'string' && partner < entity ? partner : entity;
  let h = 2166136261;
  for (let i = 0; i < phaseID.length; i++) h = Math.imul(h ^ phaseID.charCodeAt(i), 16777619);
  const phase = (((frame.tick * frame.dt + ((h >>> 0) % 10007) / 10007 * 7) * .23) % 3 + 3) % 3;
  return { at: frame.at, tick: frame.tick, renderFrame: frame.renderFrame, entity, activity: resident.activity,
    renderActivityAge: resident.activityAge, phase: Math.floor(phase),
    seated: frame.entities[entity].state?.baseActivity === 'sit' && frame.entities[entity].state?.seatHeight > 0 };
}
export function conferenceJourney(frames, soul) {
  assert(frames.length >= 2, 'conference depicted samples missing');
  const observed = frames.map(f => conferenceObservation(f, soul));
  assert(observed.at(-1).tick > observed[0].tick && observed.at(-1).renderFrame > observed[0].renderFrame, 'conference depicted clock stale');
  const phases = new Set(observed.filter(f => f.activity === 'tell-story').map(f => f.phase));
  assert(phases.size === 3, 'conference one-hand/two-hand/rest story phases not all depicted');
  for (const action of ['point', 'clap']) assert(observed.some(f => f.activity === action), `conference ${action} never depicted`);
  const lastGesture = observed.findLastIndex(f => ['tell-story', 'point', 'clap'].includes(f.activity));
  const settled = observed.slice(lastGesture + 1);
  assert(settled.length >= 2 && settled.at(-1).tick > settled[0].tick, 'conference settled endpoint not depicted');
  return { phases: [...phases].sort(), firstTick: observed[0].tick, lastTick: observed.at(-1).tick, entity: observed[0].entity };
}

// These are observations of the page's public depicted state, not inputs to its animation.
export function conferenceMeetingStage(frames, stages, event) {
  const starts = {
    'attend-done': 'attend-start', 'story-complete': 'story-start',
    'seated-wave-done': 'seated-wave-start', 'rise-done': 'rise-start',
    point: 'tell-story', settled: 'tell-story', 'question-posted': 'question-start',
    'introduction-done': 'introduction-start', 'conference-clean': 'applause-start',
  };
  const before = stages.slice(0, stages.indexOf(event));
  const start = starts[event.stage] && before.findLast(s => s.stage === starts[event.stage] && s.soul === event.soul);
  if (starts[event.stage]) assert(start, `conference ${event.stage} has no command-start marker`);
  const window = frames.slice(start?.frameIndex ?? event.frameIndex, event.endFrameIndex === undefined ? undefined : event.endFrameIndex + 1);
  assert(window.length >= 2, `conference ${event.stage} depicted samples missing`);
  assert(window.at(-1).tick > window[0].tick && window.at(-1).renderFrame > window[0].renderFrame,
    `conference ${event.stage} depicted clock stale`);
  const person = soul => window.map(frame => conferenceObservation(frame, soul));
  const seen = event.soul ? person(event.soul) : [];
  const after = predicate => {
    const index = seen.findLastIndex(predicate), tail = seen.slice(index + 1);
    assert(index >= 0 && tail.length >= 2 && tail.at(-1).tick > tail[0].tick, `conference ${event.stage} return not depicted`);
    return tail;
  };
  switch (event.stage) {
    case 'lectern-ready':
      assert(seen.at(-1).activity === 'idle' && !seen.at(-1).seated, 'standing lectern not depicted'); break;
    case 'attend-done': {
      const sat = seen.findIndex(s => s.seated && s.activity === 'sit');
      assert(sat > 0 && seen.slice(0, sat).some(s => !s.seated), 'conference sit entry not depicted');
      assert(seen.at(-1).seated && seen.at(-1).activity === 'sit', 'conference seated endpoint missing'); break;
    }
    case 'lecture-ready':
      for (const soul of event.listeners) assert(person(soul).at(-1).seated, 'conference listener not seated'); break;
    case 'story-complete':
      assert(after(s => s.activity === 'tell-story').every(s => s.activity === 'idle'), 'conference normal story return missing'); break;
    case 'tell-story': {
      const current = seen.at(-1);
      assert(current.activity === 'tell-story' && Number.isFinite(current.renderActivityAge) && current.renderActivityAge < 1.5,
        'conference started story not currently depicted'); break;
    }
    case 'point': assert(seen.some(s => s.activity === 'point'), 'conference replacement point not depicted'); break;
    case 'settled':
      for (const action of ['point', 'clap']) assert(seen.some(s => s.activity === action), `conference next ${action} not depicted`);
      assert(after(s => s.activity === 'clap').every(s => s.activity === 'idle'), 'conference next-action rest missing'); break;
    case 'seated-wave-done': {
      const tail = after(s => s.activity === 'wave');
      assert(seen.filter(s => s.activity === 'wave').every(s => s.seated), 'wave lost underlying seat');
      assert(tail.every(s => s.seated && s.activity === 'sit'), 'seated gesture did not return seated'); break;
    }
    case 'rise-done': {
      const tail = seen.slice(-2);
      assert(seen.some(s => s.seated) && tail.length === 2 && tail[1].tick > tail[0].tick &&
        tail.every(s => s.activity === 'idle' && !s.seated), 'conference rise from seat not depicted'); break;
    }
    case 'question-posted':
      assert(seen.some(s => s.activity === 'operate' && !s.seated), 'standing question action not depicted'); break;
    case 'introduction-done':
      assert(seen.some(s => s.activity === 'point') && person(event.guest).some(s => s.activity === 'bow'),
        'conference introduction gestures not depicted'); break;
    case 'conference-clean':
      for (const soul of event.seats) {
        const participant = person(soul);
        assert(participant.some(s => s.activity === 'clap'), 'conference group applause not depicted');
        const tail = participant.slice(-2);
        assert(tail.length === 2 && tail.every(s => s.activity === 'idle' && !s.seated) && tail[1].tick > tail[0].tick,
          'conference final standing rest not depicted');
      }
      break;
    default: throw Error(`unknown conference observation stage ${event.stage}`);
  }
  return { stage: event.stage, firstTick: window[0].tick, lastTick: window.at(-1).tick };
}

export function conferenceMeetingJourney(frames, stages, seats) {
  assert.equal(seats.length, 5, 'conference meeting requires five participants');
  const counts = { 'attend-done': 8, 'lectern-ready': 2, 'lecture-ready': 2, 'story-complete': 2,
    'seated-wave-done': 1, 'rise-done': 8, point: 1, settled: 1,
    'question-posted': 1, 'question-refused': 1, 'question-recovered': 1, 'introduction-done': 1, 'conference-clean': 1 };
  for (const [stage, count] of Object.entries(counts)) assert.equal(stages.filter(s => s.stage === stage).length, count,
    `conference ${stage} stage coverage incomplete`);
  const assemblies = stages.filter(s => s.stage === 'assembly-start');
  assert.equal(assemblies.length, 2, 'conference both assemblies must be captured');
  assert.notEqual(assemblies[0].soul, assemblies[1].soul, 'conference handover must change speaker');
  for (let i = 0; i < assemblies.length; i++) {
    const from = stages.indexOf(assemblies[i]), to = i + 1 < assemblies.length ? stages.indexOf(assemblies[i + 1]) : stages.length;
    assert.deepEqual(stages.slice(from, to).filter(s => s.stage === 'attend-done').map(s => s.soul).sort(),
      [...assemblies[i].listeners].sort(), 'conference entry coverage must name every listener in that assembly');
  }
  for (const event of stages) if (event.observed) conferenceMeetingStage(frames, stages, event);
  assert(stages.filter(e => counts[e.stage] && !['question-refused', 'question-recovered'].includes(e.stage)).every(e => e.observed),
    'conference depicted stage unfinished');
  const refused = stages.find(s => s.stage === 'question-refused');
  assert(refused.answer?.can === 'no' && refused.answer.reason === 'already_linked' && refused.answer.says === 'question_pending',
    'conference unrelated refusal cannot qualify question recovery');
  assert(stages.indexOf(stages.find(s => s.stage === 'question-recovered')) > stages.indexOf(refused), 'conference recovery precedes refusal');
  return { people: seats.length, entryTransitions: 8, rises: 8, question: 'posted-refused-recovered', presentations: 2,
    firstTick: frames[0].tick, lastTick: frames.at(-1).tick };
}

/** Ordinary creator proof: the edit's returned name is the only identity used for readback. */
export async function proveConferenceCreator({ creator, record = () => {}, signal }) {
  const cli = async (...words) => {
    signal?.throwIfAborted(); const answer = await creator.cli(...words);
    record({ person: creator.label, words, answer });
    assert.equal(answer.ok, true, `conference creator ${words[0]}: ${answer.code ?? 'refused'}`);
    return answer;
  };
  let described, kinds, grounds;
  for (const until = Date.now() + 10000;;) {
    described = await cli('describe');
    kinds = Object.keys(described.kinds ?? {}).filter(kind => kind.split('@')[0] === 'eden:conference_question');
    grounds = (described.nodes ?? []).filter(node => /^(?:[a-z][a-z0-9_-]*:)?ground$/.test(node.kind.split('@')[0]));
    if (kinds.length && grounds.length) break;
    assert(Date.now() < until, 'conference creator copy never lists the boot family kind and ground');
    await new Promise(ok => setTimeout(ok, 100));
  }
  assert.equal(kinds.length, 1, 'conference creator family revision must be unambiguous');
  assert.equal(grounds.length, 1, 'conference creator ground must be unambiguous');
  const kind = kinds[0], ground = grounds[0].id;
  // Declared once: flat, unused ground outside the demonstration area. Never retry a refused placement elsewhere.
  const place = await cli('place', kind, '--in', String(ground), '--at', '12,0,12');
  assert(Number.isSafeInteger(place.sequence) && place.sequence > 0, 'conference creator terminal edit sequence missing');
  assert.deepEqual(Object.keys(place.names ?? {}), ['1'], 'conference creator place must return exactly its named thing');
  const id = place.names['1']; assert(typeof id === 'string' && id, 'conference creator returned no placed identity');
  const readback = await cli('describe', id);
  assert.equal(readback.id, id, 'conference creator readback changed the returned identity');
  assert.equal(readback.kind, kind, 'conference creator readback changed the selected kind revision');
  assert.equal(String(readback.in?.[0]?.id), String(ground), 'conference creator readback is in another parent');
  assert.deepEqual(readback.at, [12, 0, 12], 'conference creator readback differs from the declared placement');
  return { kind, id, parent: ground, at: readback.at, sequence: place.sequence,
    qualification: 'ordinary describe/place/readback receipt; boot furniture supplies the clip, post-boot drawing is not claimed' };
}

export async function prepare({ base, paths, recipe, signal }) {
  requireConferenceRecipe(recipe);
  const state = { paths, signal, rows: [], seats: [] };
  states.set(paths.dir, state);
  state.record = row => state.rows.push({ at: Date.now(), ...row });
  const worldPage = await conferenceWorldPage({ base, signal });
  state.worldPage = worldPage;
  const bundle = await downloadConferenceClient({ base: worldPage, paths, signal });
  state.seats = await Promise.all(names.map((name, index) => pairConferenceSeat({
    recipe, paths, bundle, label: `conference-${index}`, name, signal,
  })));
  const find = async (words, kind) => {
    const answer = await state.seats[0].cli('find', words);
    state.record({ person: state.seats[0].label, words: ['find', words], answer });
    assert.equal(answer.ok, true, 'conference-proof ordinary fixture discovery');
    return (answer.found ?? []).filter(n => n.kind.split('@')[0] === kind);
  };
  const [lecterns, questions, benches] = await Promise.all([
    find('presentation-lectern', 'eden:hall_lecture'), find('question-stand', 'eden:conference_question'), find('audience', 'eden:bench'),
  ]);
  state.fixtures = conferenceFixtures({ lecterns, questions, benches });
  state.discovery = await discoverConference({ seat: state.seats[0], ...state.fixtures, record: state.record });
  state.creator = await pairConferenceCreator({ recipe, paths, bundle, signal });
  state.creatorProof = await proveConferenceCreator({ creator: state.creator, record: state.record, signal });
  save(paths, 'command-conference-creator.json', state.creatorProof);
  save(paths, 'command-conference-discovery.json', { fixtures: state.fixtures, discovery: state.discovery, rows: state.rows,
    servedClient: JSON.parse(readFileSync(join(paths.dir, 'conference-served-client.json'), 'utf8')) });
  return { people: state.seats.length, fixtures: state.fixtures };
}

// This exact self-contained function is serialized into the page; focused tests exercise the same stop body.
export function conferenceBrowserStop() {
  const observer = window.__conferenceDrawObserver;
  if (!observer) return undefined;
  if (observer.stopped) {
    if (observer.stopError) throw observer.stopError;
    return observer.stopResult;
  }
  observer.stopped = true;
  try {
    observer.stopRender();
    if (observer.prototype.show !== observer.show) throw Error('conference people observer ownership changed');
    observer.prototype.show = observer.original;
    return observer.stopResult = { cadenceMs: 250, sampleLimit: observer.sampleLimit, meshStride: 1,
      samples: observer.samples, failures: observer.failures,
      qualification: observer.qualification };
  } catch (error) { observer.stopError = error; throw error; }
}

export function conferenceFinalization(page, paths, state) {
  state.persistSequence = () => {
    if (state.sequenceSaved) return;
    save(paths, 'command-conference-sequence.json', {
      qualification: 'ordinary fixed-sequence conference diagnostic; independent-agent, creator and actual visual/contact acceptance remain separate',
      stage: 'before-observer-collection',
      result: state.result ?? null, failure: state.failure ?? null, rows: state.rows,
      depictedJourney: state.depictedJourney ?? null, stages: state.stages ?? [],
      frameReads: state.frameReads ?? [], frameReadErrors: state.frameReadErrors ?? [], finalizationError: state.finalizationError ?? null,
    });
    state.sequenceSaved = true;
  };
  state.finalizeDraw = () => state.drawFinalization ??= (async () => {
    // Preserve command receipts first. Returning a rejected cached promise never calls browser stop twice.
    state.persistSequence();
    try {
      const draw = await page.evaluate(conferenceBrowserStop);
      assert(draw || !state.observerInstalled, 'conference installed observer collection missing');
      if (draw) {
        save(paths, 'command-conference-final-draw.json', draw);
        assert(draw.samples?.length >= 2 && draw.failures?.length === 0, 'conference final collection missing or failed');
      }
      state.finalizationOutcome = { ok: Boolean(draw), samples: draw?.samples?.length ?? 0, failures: draw?.failures ?? [], reason: draw ? null : 'observer not installed' };
    } catch (error) {
      state.finalizationOutcome = { ok: false, error: String(error) }; throw error;
    } finally {
      save(paths, 'command-conference-finalization.json', state.finalizationOutcome);
    }
  })();
}

export async function beforeNavigation({ paths, page, base }) {
  const state = states.get(paths.dir);
  const oracleURL = new URL('/__proof/conference-oracle.mjs', base).href;
  const oracle = readFileSync(new URL('../../playtest/carry-contact/oracle.mjs', import.meta.url), 'utf8');
  await page.route(oracleURL, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: oracle }));
  state.oracleURL = oracleURL;
  const response = r => { if (new URL(r.url()).origin === new URL(base).origin && /\/people-kit-[^/]+\.js$/.test(new URL(r.url()).pathname)) state.kitURL = r.url(); };
  page.on('response', response);
  conferenceFinalization(page, paths, state);
  return async () => {
    page.off('response', response);
    try { if (!page.isClosed()) await state.finalizeDraw(); }
    finally {
      try { state.persistSequence(); }
      finally { try { await page.unroute(oracleURL); } finally { states.delete(paths.dir); } }
    }
  };
}

export default async function ({ page, paths, check, expectHttp, signal }) {
  const state = states.get(paths.dir); assert(state, 'conference-proof preparation missing');
  expectHttp('/safety.md', 404, 'The old-page fixture does not route this optional standalone client document.');
  const url = new URL(page.url()); url.search = 'post=0&hour=12:00&eye=6,3.5,6&at=0,1,2';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.viewer-history[data-viewer-ready="true"]') && !document.querySelector('.viewer-arrival'), null, { timeout: 30000 });
  const snapshot = async label => writeFileSync(join(paths.dir, `conference-accessibility-${label}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  await nativeCameraMode(page, 'manual', snapshot);
  await snapshot('escape'); await page.keyboard.press('Escape');
  const bounds = await page.locator('canvas').first().boundingBox();
  check('conference-canvas-drawn', !!bounds && bounds.width > 100 && bounds.height > 100);
  await page.screenshot({ path: join(paths.dir, 'conference-setup.png') });
  signal.throwIfAborted();
  assert(state.kitURL, 'conference production people kit not observed');
  await page.evaluate(async ({ oracleURL, kitURL, souls }) => {
    const { observeRender, bodyGeometry } = await import(oracleURL);
    const { TakePeople } = await import(kitURL), prototype = TakePeople.prototype;
    const world = window.__soulsEntity, original = prototype.show;
    if (!world || !original || window.__conferenceDrawObserver) throw Error('conference final-draw observer unavailable');
    let people, previous = -Infinity;
    function show(...args) { const result = original.apply(this, args); people = this; return result; }
    prototype.show = show;
    const samples = [], failures = [], sampleLimit = Math.ceil(90000 / 250) + 1;
    const stopRender = observeRender(world.renderer, world, stamp => {
      const at = performance.now(); if (at - previous < 250) return; previous = at;
      if (samples.length >= sampleLimit) throw Error('conference final-draw90s sample limit exceeded');
      if (!people?.humans?.meshPoints) throw Error('conference visible body mesh interface missing');
      const frame = world.gameFrame(), diagnostics = world.contactFrame().bones;
      const bodies = souls.map(soul => {
        const matches = frame.souls.filter(s => s.id === soul);
        if (matches.length !== 1) throw Error('conference final-draw identity missing or ambiguous');
        const entity = matches[0].entityId, root = people.bodyObject(entity);
        bodyGeometry(root, world.scene);
        const points = people.humans.meshPoints(entity, 1);
        if (!points.length || points.some(q => q.p.length !== 3 || !q.p.every(Number.isFinite))) throw Error('conference final-draw skin missing');
        const bounds = group => {
          if (!group.length) throw Error('conference empty skin group');
          const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], low = [], high = [];
          for (const q of group) for (let i = 0; i < 3; i++) {
            if (q.p[i] < min[i]) { min[i] = q.p[i]; low[i] = q.p; }
            if (q.p[i] > max[i]) { max[i] = q.p[i]; high[i] = q.p; }
          }
          return { vertices: group.length, min, max, extrema: { low, high } };
        };
        const legs = points.filter(q => q.part === 'leg'), feet = points.filter(q => q.part === 'foot');
        if (!legs.length || !feet.length) throw Error('conference feet or legs missing');
        const anchors = diagnostics?.[entity]?.feet;
        if (!Array.isArray(anchors) || anchors.length !== 2 || anchors.some(p => p.length !== 3 || !p.every(Number.isFinite))) throw Error('conference both foot identities missing');
        const sides = [[], []];
        for (const q of feet) {
          const distance = anchor => q.p.reduce((sum, n, i) => sum + (n - anchor[i]) ** 2, 0);
          sides[distance(anchors[0]) <= distance(anchors[1]) ? 0 : 1].push(q);
        }
        return { soul, entity, root: root.matrixWorld.toArray(), bounds: bounds(points), legs: bounds(legs), feet: bounds(feet),
          // Inferred nearest-rendered-ankle clusters; these are not native contact/rig vertex-side identities.
          footClusters: sides.map((group, index) => ({ inferred: true, nearestRenderedAnkleIndex: index, anchor: anchors[index], ...bounds(group) })),
          activity: frame.entities[entity]?.activity };
      });
      samples.push({ stage: 'after-world-render', units: 'm', at, frame: stamp.frame, tick: frame.tick, dt: frame.dt,
        currentCanvas: stamp.canvas === world.renderer.domElement && stamp.canvas.isConnected, renderTarget: null, bodies });
    }, error => { if (failures.length < 30) failures.push(String(error)); });
    window.__conferenceDrawObserver = { samples, failures, sampleLimit, stopRender, prototype, show, original,
      qualification: 'all stride1 vertices measured; bounded per-part/foot extrema retained every250ms, not every-frame coverage; no native contact certification; root must visually review all5 bodies/both feet and object clearance' };
  }, { oracleURL: state.oracleURL, kitURL: state.kitURL, souls: state.seats.map(s => s.soul) });
  state.observerInstalled = true;
  state.frameReads = []; state.frameReadErrors = []; state.stages = [];
  let reading = true;
  const readFrames = (async () => {
    while (reading && !signal.aborted) {
      try {
        const frame = await page.evaluate(() => {
          const world = window.__soulsEntity;
          if (!world?.gameFrame || !world?.residents) throw Error('conference read-only page diagnostics unavailable');
          const frame = world.gameFrame();
          return { observation: 'read between draws; not a final-draw contact measurement', at: performance.now(),
            renderFrame: world.renderer.info.render.frame, tick: frame.tick, dt: frame.dt, worldSeconds: world.worldSeconds,
            souls: frame.souls, residents: world.residents(), entities: frame.entities, bones: frame.bones };
        });
        frame.receivedAt = Date.now(); state.frameReads.push(frame);
      } catch (error) { state.frameReadErrors.push(String(error)); break; }
      await new Promise(ok => setTimeout(ok, 150));
    }
  })();
  try {
    const immediate = new Set(['assembly-start', 'attend-start', 'story-start', 'seated-wave-start', 'rise-start',
      'question-start', 'question-refused', 'question-recovered', 'departure-start', 'introduction-start', 'applause-start']);
    const observe = async (stage, details = {}) => {
      const event = { stage, at: Date.now(), frameIndex: Math.max(0, state.frameReads.length - 1),
        soul: details.seat?.soul, body: details.seat?.body, person: details.seat?.label,
        listeners: details.listeners?.map(s => s.soul), guest: details.guest?.soul,
        seats: details.seats?.map(s => s.soul), sequence: details.sequence, answer: details.answer };
      state.stages.push(event);
      if (immediate.has(stage)) return;
      // Existing bounded observer: admission, short takes or a stalled page remain failures.
      for (const until = Date.now() + 2500;;) {
        assert.equal(state.frameReadErrors.length, 0, 'conference page observation failed');
        const last = state.frameReads.at(-1);
        try {
          assert(last && Date.now() - last.receivedAt < 500, 'conference page observation stale');
          conferenceMeetingStage(state.frameReads, state.stages, event);
          event.observed = true; event.endFrameIndex = state.frameReads.length - 1; return;
        } catch (error) {
          assert(Date.now() < until, `conference ${stage} not observed on advancing page: ${error.message}`);
        }
        signal.throwIfAborted(); await new Promise(ok => setTimeout(ok, 50));
      }
    };
    state.result = await performConference({ seats: state.seats, ...state.fixtures, record: state.record,
      storyRepeats: 1, interruptStory: true, interruptFirstOnly: true, observe });
    state.depictedJourney = conferenceMeetingJourney(state.frameReads, state.stages, state.seats);
    const draw = await page.evaluate(() => ({ samples: window.__conferenceDrawObserver?.samples.length, failures: window.__conferenceDrawObserver?.failures }));
    assert(draw.samples >= 2 && draw.failures?.length === 0, 'conference final-draw measurement missing or failed');
    signal.throwIfAborted();
    check('conference-meeting-depicted', state.result.presentations === 2 && state.result.interruptedStories === 1 && state.result.handover,
      'Ordinary receipts and advancing depicted entry, seated gesture/return, rise, questions/recovery, handover and cleanup; natural limbs/contact remain visual acceptance.');
    await page.screenshot({ path: join(paths.dir, 'conference-completion.png') });
  } catch (error) { state.failure = String(error.stack ?? error); throw error; }
  finally {
    reading = false; await readFrames;
    try { await state.finalizeDraw(); }
    catch (error) { state.finalizationError = String(error); throw error; }
    finally { state.persistSequence(); }
  }
}
