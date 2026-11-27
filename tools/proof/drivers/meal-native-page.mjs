// Source-only adapter until separately approved runtime accounting and immutable artifacts exist.
// The unchanged runOwnedAttempt owns every world, browser, resident and finite command.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeCameraMode } from './camera-native-page.mjs';
import { meal, foundId } from '../../playtest/meal/meal.mjs';
import { requireConferenceRecipe, downloadConferenceClient, pairConferenceSeat } from '../../playtest/conference/owned-seats.mjs';

const states = new Map();
const save = (paths, name, value) => writeFileSync(join(paths.dir, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });

/** Existing public world discovery, scoped to this boot template; no private fixture IDs. */
export async function mealWorldPage({ base, signal }) {
  const response = await fetch(new URL('/__sim/worlds.json', base), { signal });
  assert.equal(response.status, 200, 'meal public world list');
  const rows = (await response.json()).worlds?.filter(w => w.name === 'Shared camp meal' && w.template === 'shared-camp-meal') ?? [];
  assert.equal(rows.length, 1, 'meal public world must be unambiguous');
  const page = new URL(rows[0].url, base);
  assert(page.origin === new URL(base).origin && /^\/w\/[a-z][a-z0-9-]*\/$/.test(page.pathname), 'meal page outside owned origin');
  page.search = ''; page.hash = ''; return page.href;
}

export async function prepare({ base, paths, recipe, signal }) {
  requireConferenceRecipe(recipe);
  const state = { rows: [], checkpoints: [], seats: [], installed: false }; states.set(paths.dir, state);
  const worldPage = await mealWorldPage({ base, signal });
  const bundle = await downloadConferenceClient({ base: worldPage, paths, signal });
  state.seats = await Promise.all(['cook', 'server', 'diner'].map(label => pairConferenceSeat({ recipe, paths, bundle, label,
    name: label[0].toUpperCase() + label.slice(1), signal })));
  for (const seat of state.seats) seat.run = async (...words) => {
    const answer = await seat.cli(...words); state.rows.push({ role: seat.label, words, answer }); return answer;
  };
  state.bowl = foundId(await state.seats[0].run('find', 'meal-bowl'), 'meal-bowl');
  return { people: 3, bowl: state.bowl, creatorProved: false };
}

/** Serialized into the page: passively listen to public messages; never intercept or rewrite their data. */
export function mealBrowserInstall({ bowl, bodies, limit = 361 }) {
  if (window.__mealPayloadObserver) throw Error('meal observer already installed');
  const original = window.Worker, known = new Set([bowl, ...bodies]);
  const observer = { original, listeners: [], workers: [], messages: [], failures: [], limit, stopped: false };
  const copy = value => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? { big: String(v) }
    : v instanceof Map ? Object.fromEntries(v) : v instanceof Uint8Array ? Array.from(v) : v));
  class ObservedWorker extends original {
    constructor(...args) {
      super(...args);
      // Observe a bounded number without preventing another actual worker from starting.
      if (observer.workers.length >= 8) {
        if (observer.failures.length < 10) observer.failures.push('meal worker observation limit exceeded');
        return;
      }
      const worker = { number: observer.workers.length, latest: new Map(), worldAt: null };
      observer.workers.push(worker);
      const listener = event => {
        if (observer.stopped) return;
        try {
          const message = event.data, payload = message?.t === 'snapshot' ? message.s : message?.t === 'part' ? message.p : null;
          if (!payload || !Array.isArray(payload.nodes)) return;
          if (message.t === 'snapshot') worker.latest.clear();
          const removed = (payload.removed ?? []).filter(id => known.has(id));
          for (const id of removed) worker.latest.delete(id);
          const nodes = payload.nodes.filter(n => known.has(n.id)).map(n => copy(Object.fromEntries(
            ['id', 'kind', 'parent', 'slot', 'pos', 'rot', 'at', 'body', 'slots', 'fields'].filter(k => n[k] !== undefined).map(k => [k, n[k]]))));
          for (const node of nodes) worker.latest.set(node.id, node);
          worker.worldAt = Number.isSafeInteger(payload.to) ? payload.to : null;
          if (!nodes.length && !removed.length) return;
          if (observer.messages.length >= limit) throw Error('meal public payload storage limit exceeded');
          observer.messages.push({ worker: worker.number, receivedAt: performance.now(), worldAt: worker.worldAt, type: message.t, nodes, removed });
        } catch (error) { if (observer.failures.length < 10) observer.failures.push(String(error)); }
      };
      this.addEventListener('message', listener); observer.listeners.push([this, listener]);
    }
  }
  observer.wrapped = ObservedWorker; window.__mealPayloadObserver = observer; window.Worker = ObservedWorker;
}

/** Serialized page read, deliberately separate native observation and depicted clocks. No hand labels inferred. */
export function mealCheckpoint({ bowl, holder, soul, soup, phase }) {
  const observer = window.__mealPayloadObserver, world = window.__soulsEntity;
  if (!observer || !world?.gameFrame) return null;
  if (observer.failures.length) throw Error(observer.failures.join('; '));
  const frame = world.gameFrame(), people = frame.souls?.filter(s => s.id === soul) ?? [];
  if (people.length !== 1) return null;
  const entity = frame.entities?.[people[0].entityId], set = entity?.state?.heldEntries;
  const entries = set?.entries?.filter(e => e.id === bowl) ?? [];
  if (entries.length !== 1 || entries[0].parent !== holder || entries[0].state?.soup !== soup) return null;
  const held = entries[0], base = entity.state?.baseActivity ?? entity.activity;
  if (phase === 'seated' && base !== 'sit' || phase === 'risen' && base !== 'idle') return null;
  if (!Number.isFinite(frame.tick) || !Number.isFinite(frame.dt) || !Number.isSafeInteger(set.observedAt)) return null;
  const quantity = v => v === soup || v?.big === String(soup);
  const raw = observer.workers.filter(w => {
    const n = w.latest.get(bowl);
    return n?.parent === holder && quantity(n.fields?.['28']);
  });
  if (raw.length !== 1) return null; // No guessed live/history source or missing raw quantity.
  if (!quantity(held.fields?.['28'])) return null;
  const worker = raw[0], native = worker.latest.get(bowl), body = worker.latest.get(holder);
  if (native.kind !== held.kind || native.slot !== held.slot || JSON.stringify(native.pos) !== JSON.stringify(held.pos) || JSON.stringify(native.rot) !== JSON.stringify(held.rot)) return null;
  const rows = body?.slots?.filter(row => row[0] === native.slot) ?? [];
  return { phase, soup, native: { worker: worker.number, worldAt: worker.worldAt, bowl: native, body: body ?? null,
    slotRow: rows.length === 1 ? rows[0] : null, handLabel: null }, depicted: { tick: frame.tick, dt: frame.dt, activity: entity.activity,
    baseActivity: entity.state?.baseActivity ?? null, observedAt: set.observedAt, entity: people[0].entityId, held },
    qualification: 'Payload/state observation; slot semantics, actual mesh attachment, natural limbs, clearance and grounding are unproved.' };
}

/** Stop once, detach only our listeners and retain a cached result/error for repeated finalization. */
export function mealBrowserStop() {
  const observer = window.__mealPayloadObserver;
  if (!observer) return undefined;
  if (observer.stopped) { if (observer.error) throw observer.error; return observer.result; }
  observer.stopped = true;
  try {
    for (const [worker, listener] of observer.listeners) worker.removeEventListener('message', listener);
    if (window.Worker !== observer.wrapped) throw Error('meal observer ownership changed');
    window.Worker = observer.original;
    return observer.result = { messages: observer.messages, failures: observer.failures, limit: observer.limit,
      qualification: 'Passive public messages, not an attachment or final-draw contact measurement.' };
  } catch (error) { observer.error = error; throw error; }
}

export function mealFinalization(page, paths, state) {
  state.persist = () => {
    if (state.persisted) return;
    save(paths, 'command-meal-sequence.json', { rows: state.rows, checkpoints: state.checkpoints, result: state.result ?? null, failure: state.failure ?? null,
      qualification: 'Reduced payload diagnostic; full meal/creator/physical/independent-agent acceptance remains open.' });
    state.persisted = true;
  };
  state.finalize = () => state.finalization ??= (async () => {
    state.persist(); // Receipts survive lost browser context or rejected collection.
    try {
      const payload = await page.evaluate(mealBrowserStop);
      assert(payload || !state.installed, 'meal installed observer collection missing');
      if (payload) { save(paths, 'command-meal-public-payload.json', payload); assert.equal(payload.failures.length, 0, 'meal public payload observation failed'); }
      return payload;
    } catch (error) { save(paths, 'command-meal-finalization-error.json', { error: String(error) }); throw error; }
  })();
}

export async function beforeNavigation({ paths, page }) {
  const state = states.get(paths.dir); assert(state, 'meal preparation missing');
  await page.addInitScript(mealBrowserInstall, { bowl: state.bowl, bodies: state.seats.map(s => s.body) });
  state.installed = true;
  mealFinalization(page, paths, state);
  return async () => { try { if (!page.isClosed()) await state.finalize(); } finally { state.persist(); states.delete(paths.dir); } };
}

export default async function ({ page, paths, check, expectHttp, signal }) {
  const state = states.get(paths.dir); assert(state, 'meal preparation missing');
  expectHttp('/safety.md', 404, 'The old-page fixture does not route this optional standalone client document.');
  const url = new URL(page.url()); url.search = 'post=0&hour=12:00&eye=7,4,9&at=0,1,1.5';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.viewer-history[data-viewer-ready="true"]') && !document.querySelector('.viewer-arrival'), null, { timeout: 30000 });
  const snapshot = async label => writeFileSync(join(paths.dir, `meal-accessibility-${label}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  await nativeCameraMode(page, 'manual', snapshot); await page.keyboard.press('Escape');
  assert(await page.evaluate(() => !!window.__mealPayloadObserver), 'meal observer not installed'); state.installed = true;
  const observe = async row => {
    signal.throwIfAborted();
    const seat = state.seats.find(s => s.label === row.role);
    const handle = await page.waitForFunction(mealCheckpoint, { bowl: state.bowl, holder: row.holder, soul: seat.soul, soup: row.soup, phase: row.phase }, { timeout: 5000 });
    const checkpoint = await handle.jsonValue(); await handle.dispose();
    const prior = state.checkpoints.at(-1);
    assert(!prior || checkpoint.depicted.tick > prior.depicted.tick, 'meal depicted clock must advance between phases');
    state.checkpoints.push(checkpoint);
    if (['seated', 'bitten', 'risen'].includes(row.phase)) await page.waitForTimeout(2000);
    signal.throwIfAborted();
  };
  try {
    state.result = await meal({ seats: state.seats, report: { complete: false, steps: [] }, endpoint: 'empty-bowl-risen', observe });
    check('meal-same-bowl-payload', state.result.portionComplete === true && state.result.complete === false && state.checkpoints.length === 6,
      'Ordinary consent/quantities plus raw and depicted metadata; visual shape/contact and creator acceptance remain unproved.');
  } catch (error) { state.failure = String(error.stack ?? error); throw error; }
  finally { await state.finalize(); }
}
