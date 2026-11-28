// Five-Soul, object-free party on the unchanged owned native-page runner. No lifecycle is started here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performParty } from '../../playtest/party/rehearse.mjs';
import { downloadConferenceClient, pairConferenceSeat, requireConferenceRecipe } from '../../playtest/conference/owned-seats.mjs';
import { conferenceClearanceTools } from './conference-native-page.mjs';
import { nativeCameraMode } from './camera-native-page.mjs';

export const partyCaptureMs = 90000; // The owning attempt must also set its journey ceiling to this value.
export const partyStageWaitMs = stage => stage === 'dance-ready' ? 12000 : 2500;
const states = new Map(), names = ['Cedar', 'Maple', 'Willow', 'Birch', 'Aspen'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (paths, name, data) => writeFileSync(join(paths.dir, name), JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });

export function partyPage(catalog, base) {
  const rows = catalog.worlds?.filter(w => w.name === 'Silent party rehearsal' && w.template === 'party-rehearsal') ?? [];
  assert.equal(rows.length, 1, 'party public world discovery ambiguous or missing');
  const page = new URL(rows[0].url, base);
  assert(page.origin === new URL(base).origin && /^\/w\/[a-z][a-z0-9-]*\/$/.test(page.pathname), 'party world must stay on the owned origin');
  page.search = ''; page.hash = ''; return page.href;
}

export function partyBoot(kindsBytes, activitiesBytes) {
  const activities = JSON.parse(activitiesBytes);
  assert.equal(activities.format, 'souls-activities/1', 'party boot activity format');
  const rows = activities.activities?.filter(a => a.kind === 'eden:dance_together' && a.word === 'dance-together') ?? [];
  assert.equal(rows.length, 1, 'party boot dance missing or ambiguous');
  const activity = rows[0];
  assert(typeof activity.name === 'string' && activity.name && !activity.at, 'party boot must name the object-free activity pin');
  const lines = kindsBytes.toString().split('\n').filter(line => line.startsWith('# souls-boot-activity ') && line.split(/\s+/)[3] === activity.name);
  assert.equal(lines.length, 1, 'party world.kinds must retain the matching boot registration');
  return { bootLine: lines[0], activity, worldKindsSHA256: hash(kindsBytes), activitiesSHA256: hash(activitiesBytes),
    qualification: 'actual boot registration and served activity metadata; no creator place/use command exists for an object-free activity' };
}

// This function executes in the browser: transfer time must not become render-sample age.
export function partyDrawSnapshot() {
  const { samples, failures } = window.__partyDrawObserver;
  const sampledNow = performance.now(), lastSampleAt = samples.at(-1)?.at ?? null;
  const lastSampleAgeMs = lastSampleAt === null ? null : sampledNow - lastSampleAt;
  return { samples, failures, sampledNow, lastSampleAt, lastSampleAgeMs,
    fresh: lastSampleAgeMs !== null && lastSampleAgeMs < 500 };
}

// Depicted state is read only at the final world/camera/null-target draw. It is not native contact truth.
export function partyStage(samples, stages, event) {
  const startName = { 'greeting-done': 'greeting-start', 'reply-done': 'reply-start',
    'dance-sustained': 'dance-ready', 'departure-done': 'departure-start', 'party-clean': 'cleanup-start' }[event.stage];
  const prior = stages.slice(0, stages.indexOf(event));
  const start = startName && prior.findLast(e => e.stage === startName);
  if (startName) assert(start, `party ${event.stage} start missing`);
  const window = samples.slice(start?.endSampleIndex ?? start?.sampleIndex ?? 0);
  assert(window.length >= 2 && window.at(-1).tick > window[0].tick && window.at(-1).frame > window[0].frame, 'party final-draw clock missing or stale');
  assert(window.every(s => s.currentCanvas && s.bodies.length === 5), 'party whole-group drawn samples missing');
  const activities = soul => window.map(s => {
    const body = s.bodies.filter(b => b.soul === soul);
    assert.equal(body.length, 1, 'party depicted Soul missing or ambiguous'); return body[0].activity;
  });
  const tail = soul => activities(soul).slice(-2);
  if (event.stage === 'greeting-done' || event.stage === 'reply-done') {
    const action = event.stage === 'greeting-done' ? 'wave' : 'nod';
    assert(activities(event.soul).includes(action) && tail(event.soul).every(a => a === 'idle'), `party ${action} greeting/return not depicted`);
  } else if (['dance-ready', 'dance-sustained'].includes(event.stage)) {
    assert(event.souls.every(s => tail(s).every(a => a === 'dance')), 'party all five shared dancers not depicted');
    if (event.stage === 'dance-sustained') {
      assert(window.at(-1).at - window[0].at >= 11500, 'party sustained dance interval missing');
      assert(event.souls.every(s => activities(s).every(a => a === 'dance')), 'party sustained dance interrupted in sampled interval');
    }
  } else if (event.stage === 'departure-done') {
    assert(activities(event.soul).includes('wave') && tail(event.soul).every(a => a === 'idle'), 'party departure wave/rest not depicted');
    assert(event.souls.every(s => activities(s).every(a => a === 'dance')), 'party four continuing dancers not depicted');
  } else if (event.stage === 'party-clean') {
    assert(activities(event.soul).includes('nod'), 'party final host nod missing');
    assert(event.souls.every(s => tail(s).every(a => a === 'idle')), 'party all-left rest not depicted');
  } else assert.fail(`unknown party observation stage ${event.stage}`);
  return { firstTick: window[0].tick, lastTick: window.at(-1).tick, samples: window.length };
}

export async function prepare({ base, paths, recipe, signal }) {
  requireConferenceRecipe(recipe);
  const state = { rows: [], seats: [], stages: [] }; states.set(paths.dir, state);
  state.record = row => state.rows.push({ at: Date.now(), ...row });
  const response = await fetch(new URL('/__sim/worlds.json', base), { signal });
  assert.equal(response.status, 200, 'party public world list');
  const worldPage = partyPage(await response.json(), base);
  const bundle = await downloadConferenceClient({ base: worldPage, paths, signal });
  state.seats = await Promise.all(names.map((name, i) => pairConferenceSeat({ recipe, paths, bundle, label: `party-${i}`, name, signal })));
  // Existing native-page -> old-page -> run.sh layout, not a guessed external artifact path.
  const world = join(paths.data, 'world', 'world');
  state.boot = partyBoot(readFileSync(join(world, 'world.kinds')), readFileSync(join(world, 'activities.json')));
  save(paths, 'command-party-boot.json', state.boot);
  return { people: 5, mode: 'silent', jukebox: 'not-present' };
}

export function partyBrowserStop() {
  const observer = window.__partyDrawObserver;
  if (!observer) return undefined;
  if (observer.stopped) { if (observer.stopError) throw observer.stopError; return observer.stopResult; }
  observer.stopped = true;
  try {
    observer.stopRender();
    if (observer.prototype.show !== observer.show) throw Error('party people observer ownership changed');
    observer.prototype.show = observer.original;
    const measurementSummary = observer.samples.reduce((s, row) => {
      if (!Number.isFinite(row.measurementMs) || row.measurementMs < 0) throw Error('party measurement timing missing');
      s.count++; s.totalMs += row.measurementMs; s.maxMs = Math.max(s.maxMs, row.measurementMs); return s;
    }, { count: 0, totalMs: 0, maxMs: 0, basis: 'retained successful samples; failed callbacks are not timed' });
    return observer.stopResult = { samples: observer.samples, failures: observer.failures, cadenceMs: 250,
      sampleLimit: observer.sampleLimit, measurementSummary, qualification: observer.qualification };
  } catch (error) { observer.stopError = error; throw error; }
}

export function partyFinalization(page, paths, state) {
  state.persist = () => {
    if (state.saved) return;
    save(paths, 'command-party-sequence.json', { rows: state.rows, stages: state.stages, result: state.result ?? null,
      failure: state.failure ?? null, qualification: 'fixed ordinary-command diagnostic; no independent-agent or complete visual/contact acceptance' });
    state.saved = true;
  };
  state.finalize = () => state.finalization ??= (async () => {
    state.persist();
    try {
      const draw = await page.evaluate(partyBrowserStop);
      assert(draw || !state.observerInstalled, 'party installed draw collector missing');
      if (draw) { save(paths, 'command-party-final-draw.json', draw); assert(draw.samples.length >= 2 && draw.failures.length === 0, 'party final draw collection failed'); }
      state.outcome = { ok: !!draw, samples: draw?.samples.length ?? 0,
        journeyFailure: state.failure ?? null, finalizationFailure: null };
    } catch (error) { state.outcome = { ok: false, error: String(error), journeyFailure: state.failure ?? null,
      finalizationFailure: String(error.stack ?? error) }; throw error; }
    finally { save(paths, 'command-party-finalization.json', state.outcome); }
  })();
}

/** Keep the original journey and collector failures without waiving either cleanup result. */
export async function partyJourney(state, journey) {
  let primary;
  try { return await journey(); }
  catch (error) { primary = error; state.failure = String(error.stack ?? error); throw error; }
  finally {
    try { await state.finalize(); }
    catch (secondary) {
      if (primary) throw new AggregateError([primary, secondary], 'party journey and finalization both failed', { cause: primary });
      throw secondary;
    }
  }
}

export async function beforeNavigation({ paths, page, base }) {
  const state = states.get(paths.dir); assert(state, 'party preparation missing');
  const oracleURL = new URL('/__proof/party-oracle.mjs', base).href;
  const geometryURL = new URL('/__proof/party-body.mjs', base).href;
  await page.route(oracleURL, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(new URL('../../playtest/carry-contact/oracle.mjs', import.meta.url), 'utf8') }));
  await page.route(geometryURL, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: `export ${conferenceClearanceTools.toString()}` }));
  Object.assign(state, { oracleURL, geometryURL });
  const response = r => { if (new URL(r.url()).origin === new URL(base).origin && /\/people-kit-[^/]+\.js$/.test(new URL(r.url()).pathname)) state.kitURL = r.url(); };
  page.on('response', response); partyFinalization(page, paths, state);
  return async () => {
    page.off('response', response);
    try { if (!page.isClosed()) await state.finalize(); }
    finally { try { state.persist(); } finally { try { await page.unroute(oracleURL); } finally { try { await page.unroute(geometryURL); } finally { states.delete(paths.dir); } } } }
  };
}

export default async function ({ page, paths, check, expectHttp, signal }) {
  const state = states.get(paths.dir); assert(state, 'party preparation missing');
  expectHttp('/safety.md', 404, 'The old-page fixture does not route this optional standalone client document.');
  const url = new URL(page.url()); url.search = 'post=0&hour=12:00&eye=6,5,8&at=1,.8,-.7';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.viewer-history[data-viewer-ready="true"]') && !document.querySelector('.viewer-arrival'), null, { timeout: 30000 });
  const snapshot = async label => writeFileSync(join(paths.dir, `party-accessibility-${label}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  await nativeCameraMode(page, 'manual', snapshot); await snapshot('escape'); await page.keyboard.press('Escape');
  await page.screenshot({ path: join(paths.dir, 'party-setup.png') }); // Root must visually inspect full bodies/both feet; bounds do not qualify framing.
  assert(state.kitURL, 'party production people kit missing');
  await page.evaluate(async ({ oracleURL, geometryURL, kitURL, souls }) => {
    const { observeRender, bodyGeometry, drawnLoad } = await import(oracleURL);
    const { conferenceClearanceTools } = await import(geometryURL), { TakePeople } = await import(kitURL);
    const world = window.__soulsEntity, prototype = TakePeople.prototype, original = prototype.show;
    if (!world || !original || window.__partyDrawObserver) throw Error('party final-draw interface unavailable');
    const geometry = conferenceClearanceTools({ vector: () => world.camera.position.clone(), bodyGeometry, drawnLoad });
    const samples = [], failures = [], sampleLimit = Math.ceil(90000 / 250) + 1;
    let people, previous = -Infinity;
    function show(...args) { const result = original.apply(this, args); people = this; return result; }
    prototype.show = show;
    const bounds = points => {
      if (!points.length) throw Error('party empty actual skin group');
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], low = [], high = [];
      for (const { p } of points) for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) { min[i] = p[i]; low[i] = p; }
        if (p[i] > max[i]) { max[i] = p[i]; high[i] = p; }
      }
      return { vertices: points.length, min, max, extrema: { low, high } };
    };
    const stopRender = observeRender(world.renderer, world, stamp => {
      const at = performance.now(); if (at - previous < 250) return; previous = at;
      if (samples.length >= sampleLimit) throw Error('party final-draw90s limit exceeded');
      if (!people?.bodyObject || !world.residents) throw Error('party actual body interface missing');
      const frame = world.gameFrame(), residents = world.residents();
      const bodies = souls.map(soul => {
        const matches = frame.souls.filter(s => s.id === soul);
        if (matches.length !== 1) throw Error('party depicted identity missing or ambiguous');
        const entity = matches[0].entityId, resident = residents.find(r => r.id === soul && r.body === entity);
        if (!resident || !frame.entities[entity]) throw Error('party resident missing');
        const root = people.bodyObject(entity), points = geometry.body(root, world.scene);
        const feet = points.filter(q => q.part === 'foot'), legs = points.filter(q => q.part === 'leg');
        const sides = ['L', 'R'].map(side => feet.filter(q => q.bone.endsWith(side)));
        return { soul, entity, activity: resident.activity, renderActivityAge: resident.activityAge,
          depictedPartner: frame.entities[entity].state?.partner ?? null, root: root.matrixWorld.toArray(),
          bounds: bounds(points), legs: bounds(legs), feet: bounds(feet),
          footGroups: sides.map((group, i) => ({ inferred: true, dominantBoneSuffix: ['L','R'][i], ...bounds(group) })) };
      });
      samples.push({ at, tick: frame.tick, dt: frame.dt, frame: stamp.frame, stage: 'after-world-render', units: 'm',
        currentCanvas: stamp.canvas === world.renderer.domElement && stamp.canvas.isConnected, renderTarget: null, bodies,
        measurementMs: performance.now() - at });
    }, error => { if (failures.length < 30) failures.push(String(error)); });
    window.__partyDrawObserver = { samples, failures, sampleLimit, stopRender, prototype, original, show,
      qualification: 'actual visible submitted bodyDraw vertex extrema every250ms, not every-frame or complete body/body triangle clearance; foot groups inferred from dominant skin bone; no native contact/beat certification; original full-body video and both feet still require visual inspection' };
  }, { oracleURL: state.oracleURL, geometryURL: state.geometryURL, kitURL: state.kitURL, souls: state.seats.map(s => s.soul) });
  state.observerInstalled = true;
  const began = Date.now();
  return partyJourney(state, async () => {
    const immediate = new Set(['greeting-start', 'reply-start', 'departure-start', 'cleanup-start']);
    const observe = async (stage, details) => {
      const status = await page.evaluate(() => ({ count: window.__partyDrawObserver.samples.length }));
      const event = { stage, at: Date.now(), sampleIndex: Math.max(0, status.count - 1), soul: details.seat?.soul, souls: details.seats?.map(s => s.soul), activityId: details.activityId };
      state.stages.push(event); if (immediate.has(stage)) return;
      for (const until = Date.now() + partyStageWaitMs(stage);;) {
        signal.throwIfAborted(); assert(Date.now() - began < partyCaptureMs, 'party hard90s journey exceeded');
        const requestStarted = performance.now();
        const draw = await page.evaluate(partyDrawSnapshot);
        (event.observationPolls ??= []).push({ sampledNow: draw.sampledNow, lastSampleAt: draw.lastSampleAt,
          lastSampleAgeMs: draw.lastSampleAgeMs, requestTransportMs: performance.now() - requestStarted });
        assert.equal(draw.failures.length, 0, 'party actual draw observation failed');
        assert(draw.fresh, 'party draw observation stale');
        try { event.observed = partyStage(draw.samples, state.stages, event); event.endSampleIndex = draw.samples.length - 1; return; }
        catch (error) { assert(Date.now() < until, `party ${stage} not depicted: ${error.message}`); }
        await new Promise(done => setTimeout(done, 50));
      }
    };
    state.result = await performParty({ seats: state.seats, mode: 'silent', jukebox: null, record: state.record, observe });
    assert(Date.now() - began < partyCaptureMs, 'party hard90s journey exceeded');
    check('party-ordinary-sequence-depicted', state.result.allLeft && state.stages.filter(s => s.observed).length === 6,
      'Five ordinary consented dancers, sustained activity, departure/wave with four continuing and final rest; geometry/continuity require original-video review.');
    await page.screenshot({ path: join(paths.dir, 'party-completion.png') });
  });
}
