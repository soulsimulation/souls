// Actual-page conference composition diagnostic. Receipts/canvas readiness do not qualify animation/contact.
// The unchanged runOwnedAttempt owns the sole native world, all registered clients/commands and the browser.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeCameraMode } from './camera-native-page.mjs';
import { assembleConference, discoverConference, explainConference } from '../../playtest/conference/rehearse.mjs';
import { conferenceWorldPage, downloadConferenceClient, pairConferenceSeat, requireConferenceRecipe } from '../../playtest/conference/owned-seats.mjs';

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
    renderActivityAge: resident.activityAge, phase: Math.floor(phase) };
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
  await assembleConference({ seats: state.seats, ...state.fixtures, record: state.record });
  save(paths, 'conference-discovery.json', { fixtures: state.fixtures, discovery: state.discovery, rows: state.rows });
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
    save(paths, 'conference-sequence.json', {
      qualification: 'concise storytelling diagnostic; full question, handover and independent-agent acceptance remain open',
      stage: 'before-observer-collection',
      result: state.result ?? null, failure: state.failure ?? null, rows: state.rows,
      depictedJourney: state.depictedJourney ?? null,
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
        save(paths, 'conference-final-draw.json', draw);
        assert(draw.samples?.length >= 2 && draw.failures?.length === 0, 'conference final collection missing or failed');
      }
      state.finalizationOutcome = { ok: Boolean(draw), samples: draw?.samples?.length ?? 0, failures: draw?.failures ?? [], reason: draw ? null : 'observer not installed' };
    } catch (error) {
      state.finalizationOutcome = { ok: false, error: String(error) }; throw error;
    } finally {
      save(paths, 'conference-finalization.json', state.finalizationOutcome);
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
  state.frameReads = []; state.frameReadErrors = [];
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
    const soul = state.seats[0].soul;
    const observe = async activity => {
      const startingTick = state.frameReads.at(-1)?.tick ?? -Infinity;
      for (const until = Date.now() + 2500;;) {
        assert.equal(state.frameReadErrors.length, 0, 'conference page observation failed');
        const frames = state.frameReads, last = frames.at(-1);
        if (last) {
          const current = conferenceObservation(last, soul);
          const fresh = Date.now() - last.receivedAt < 500;
          if (activity === 'tell-story' && fresh && current.tick > startingTick && current.activity === activity && Number.isFinite(current.renderActivityAge) && current.renderActivityAge < 1.5) return;
          if (activity === 'point' && frames.some(f => conferenceObservation(f, soul).activity === 'point')) return;
          if (activity === 'settled') {
            try { state.depictedJourney = conferenceJourney(frames, soul); return; } catch { /* bounded settling below */ }
          }
        }
        assert(Date.now() < until, `conference ${activity} not observed on advancing page`);
        signal.throwIfAborted(); await new Promise(ok => setTimeout(ok, 50));
      }
    };
    state.result = await explainConference({ speaker: state.seats[0], ...state.fixtures, record: state.record, storyRepeats: 4, interruptStory: true, observe });
    state.depictedJourney = conferenceJourney(state.frameReads, soul);
    const draw = await page.evaluate(() => ({ samples: window.__conferenceDrawObserver?.samples.length, failures: window.__conferenceDrawObserver?.failures }));
    assert(draw.samples >= 2 && draw.failures?.length === 0, 'conference final-draw measurement missing or failed');
    signal.throwIfAborted();
    check('conference-presentation-receipts', state.result.storyActions === 4 && state.result.interrupted === true,
      'Ordinary receipts plus advancing depicted story phrases, point, clap and settled endpoint; natural limbs/contact remain visual acceptance.');
    await page.screenshot({ path: join(paths.dir, 'conference-completion.png') });
  } catch (error) { state.failure = String(error.stack ?? error); throw error; }
  finally {
    reading = false; await readFrames;
    try { await state.finalizeDraw(); }
    catch (error) { state.finalizationError = String(error); throw error; }
    finally { state.persistSequence(); }
  }
}
