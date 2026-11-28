// Source-only adapter until separately approved runtime accounting and immutable artifacts exist.
// The unchanged runOwnedAttempt owns every world, browser, resident and finite command.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { nativeCameraMode } from './camera-native-page.mjs';
import { meal, foundId } from '../../playtest/meal/meal.mjs';
import { requireConferenceRecipe, downloadConferenceClient, pairConferenceSeat, pairConferenceCreator } from '../../playtest/conference/owned-seats.mjs';

const states = new Map();
// Private archive encoding only; delivered Worker objects and selected checkpoint spelling stay unchanged.
// $mealArchive tags retain numbers (including documented NaN sentinels), BigInt, bytes and explicit undefined.
// Literal objects carrying that tag key are escaped as entries, so they cannot impersonate a typed value.
export function mealArchiveJSON(value) {
  return JSON.stringify(value, (_key, v) => typeof v === 'number' && !Number.isFinite(v) ? { $mealArchive: 'Number', value: Number.isNaN(v) ? 'NaN' : v > 0 ? '+Infinity' : '-Infinity' }
    : typeof v === 'bigint' ? { $mealArchive: 'BigInt', decimal: String(v) }
    : v instanceof Uint8Array ? { $mealArchive: 'Uint8Array', bytes: Array.from(v) }
    : v === undefined ? { $mealArchive: 'undefined' }
    : v && typeof v === 'object' && Object.hasOwn(v, '$mealArchive') ? { $mealArchive: 'object', entries: Object.entries(v) } : v, 2);
}
const save = (paths, name, value) => writeFileSync(join(paths.dir, name), mealArchiveJSON(value), { flag: 'wx', mode: 0o600 });

/** CLI and public stream spelling of the same native ID; never manufacture an alias for an unknown format. */
export function mealNodeIdentity(original) {
  const match = typeof original === 'string' && /^([a-f0-9]{32})[-.](0|[1-9][0-9]*)$/.exec(original);
  assert(match && BigInt(match[2]) <= 0xffffffffffffffffn, 'meal native ID format unknown');
  return { original, cli: `${match[1]}-${match[2]}`, worker: `${match[1]}.${match[2]}` };
}

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

/** Creator legality comes from the ordinary place receipt; optional admits metadata is evidence only. */
export async function proveMealCreator({ creator, record = () => {}, signal }) {
  const cli = async (...words) => {
    signal?.throwIfAborted();
    const answer = await creator.cli(...words);
    record({ role: creator.label, words, answer });
    assert.equal(answer.ok, true, `meal creator ${words[0]}: ${answer.code ?? 'refused'}`);
    return answer;
  };
  const described = await cli('describe');
  const bowlKinds = Object.keys(described.kinds ?? {}).filter(kind => kind.split('@')[0] === 'eden:soup_bowl');
  assert.equal(bowlKinds.length, 1, 'meal creator loaded bowl revision must be unique');
  const requestedKind = bowlKinds[0];
  assert(/^eden:soup_bowl@[^\s@]+$/.test(requestedKind), 'meal creator bowl revision must be qualified');
  const grounds = (described.nodes ?? []).filter(node => node.kind?.split('@')[0] === 'eden:ground');
  assert.equal(grounds.length, 1, 'meal creator ground must be unique');
  const ground = grounds[0];
  assert(typeof ground.id === 'string' && ground.id, 'meal creator ground identity missing');
  const groundKinds = Object.keys(described.kinds ?? {}).filter(kind => kind.split('@')[0] === 'eden:ground');
  const groundKey = Object.hasOwn(described.kinds ?? {}, ground.kind) ? ground.kind : groundKinds.length === 1 ? groundKinds[0] : null;
  const groundMetadata = groundKey ? described.kinds[groundKey] : null;
  const admissionMetadata = groundMetadata && typeof groundMetadata === 'object' && Object.hasOwn(groundMetadata, 'admits')
    ? { kind: groundKey, admits: groundMetadata.admits } : null;
  // One declared unused position, outside the meal workflow. No retry elsewhere on refusal.
  const at = [12, 0, 12];
  const placed = await cli('place', requestedKind, '--in', ground.id, '--at', at.join(','));
  assert(Number.isSafeInteger(placed.sequence) && placed.sequence > 0, 'meal creator edit sequence missing');
  assert.deepEqual(Object.keys(placed.names ?? {}), ['1'], 'meal creator place must return exactly one identity');
  const id = placed.names['1'];
  assert(typeof id === 'string' && id, 'meal creator placed identity missing');
  const readback = await cli('describe', id);
  assert.equal(readback.id, id, 'meal creator readback identity differs');
  assert.equal(readback.kind, 'eden:soup_bowl', 'meal creator readback plain kind differs');
  assert.equal(readback.in?.[0]?.id, ground.id, 'meal creator readback parent differs');
  assert.deepEqual(readback.at, at, 'meal creator readback position differs');
  return { requestedKind, readbackKind: readback.kind, id, parent: ground.id, at: readback.at,
    sequence: placed.sequence, admissionMetadata,
    qualification: 'Ordinary exact-revision place and returned-ID plain-kind readback; optional admission metadata may be unknown. No readback revision, post-boot drawing, meal consumption or contact claim.' };
}

/** Ordinary wear is a real native command/receipt; catalogue identity remains a separate observed page check. */
export async function wearMealBody({seat,bodies,verify,record=()=>{},signal}) {
  assert(signal&&typeof signal.throwIfAborted==='function','meal wear requires the bounded preparation signal');
  verify();signal.throwIfAborted();
  const bytes=readFileSync(bodies.catalogue);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),bodies.sha256,'meal catalogue receipt drift');
  const catalogue=JSON.parse(bytes),rows=catalogue.bodies?.filter(row=>row.preset==='monster')??[];
  assert.equal(rows.length,1,'meal declared monster preset must be unique');
  const row=rows[0];assert(/^[a-z][a-z0-9_]*\.json$/.test(row.entry)&&/^[a-f0-9]{64}$/.test(row.hash),'meal declared body identity malformed');
  const companionBytes=readFileSync(join(dirname(bodies.catalogue),row.entry)),companion=JSON.parse(companionBytes);
  assert.equal(companion.kindHash,row.hash,'meal companion kind differs from admitted preset');
  assert.equal(createHash('sha256').update(companionBytes).digest('hex'),row.entryHash,'meal companion entryHash drift');
  assert.deepEqual(companion.resources.filter(r=>r[0]==='souls:hand-left'||r[0]==='souls:hand-right').map(r=>r.slice(0,2)),[['souls:hand-left',2],['souls:hand-right',2]],'meal declared body requires actual named hands');
  const run=async words=>{signal.throwIfAborted();const answer=await seat.cli(...words);record({role:seat.label,words,answer});return answer;};
  const sent=await run(['wear',row.preset]);
  if(sent?.ok!==true||sent.sent!==true)throw Object.assign(Error(`wear declared meal body: ${sent?.code??sent?.reason??'intent not sent'}`),{answer:sent});
  assert(Number.isSafeInteger(sent.sequence)&&sent.sequence>0&&sent.verb==='life:wear','meal wear sequence or verb missing');
  for(;;){
    const answer=await run(['receipt',String(sent.sequence)]),receipt=answer?.receipt;
    if(answer?.ok!==true)throw Object.assign(Error(`wear receipt: ${answer?.code??answer?.reason??'invalid answer'}`),{answer});
    assert((answer.sequence===undefined||answer.sequence===sent.sequence)&&receipt?.sequence===sent.sequence,'meal wear receipt sequence differs');
    assert.deepEqual(receipt.verbs,['life:wear'],'meal wear receipt verb differs');assert(Array.isArray(receipt.answers),'meal wear receipt answers missing');
    assert(receipt.answers.every(a=>a&&typeof a.answer==='string'),'meal wear receipt answer malformed');const end=receipt.answers.at(-1);
    if(end?.answer==='receipt')return {preset:row.preset,hash:row.hash,entryHash:row.entryHash,resources:companion.resources,sequence:sent.sequence,receipt,
      qualification:'Ordinary terminal wear receipt for a declared existing preset; native/page identity checks remain separate and default mapping remains unproved.'};
    if(end&&end.answer!=='accepted')throw Object.assign(Error(`wear receipt: ${end.reason??end.answer}`),{answer});
    signal.throwIfAborted();await pause(200,undefined,{signal});
  }
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
  if(recipe.bodies){
    const rows=[];
    try{state.declaredBody=await wearMealBody({seat:state.seats[2],bodies:recipe.bodies,verify:recipe.verify,signal,record:row=>{state.rows.push(row);rows.push(row);}});}
    finally{save(paths,'command-meal-wear.json',{rows,declaredBody:state.declaredBody??null,qualification:'Ordinary sent acknowledgement and exact-sequence receipt reads; native/page/physical acceptance remains separate.'});}
  }
  state.bowl = foundId(await state.seats[0].run('find', 'meal-bowl'), 'meal-bowl');
  state.creator = await pairConferenceCreator({ recipe, paths, bundle, signal });
  const creatorRows = [];
  try {
    state.creatorProof = await proveMealCreator({ creator: state.creator, signal,
      record: row => { creatorRows.push(row); state.rows.push(row); } });
  } finally {
    save(paths, 'command-meal-creator.json', { proof: state.creatorProof ?? null, rows: creatorRows });
  }
  return { people: 3, bowl: state.bowl, creatorProved: true, creatorPlaced: state.creatorProof.id };
}

/** Serialized into the page: passively listen to public messages; never intercept or rewrite their data. */
export function mealBrowserInstall({ bowl, bodies, identities, limit = 361, maxBytes = 33554432, maxNodes = 20000, maxRecords = 1000000 }) {
  if (window.__mealPayloadObserver) throw Error('meal observer already installed');
  const original = window.Worker, known = new Set([bowl, ...bodies]);
  const bounds = { messages: 361, workers: 8, bytes: 33554432, nodes: 20000, records: 1000000, depth: 64 };
  for (const [value, cap] of [[limit,bounds.messages],[maxBytes,bounds.bytes],[maxNodes,bounds.nodes],[maxRecords,bounds.records]]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > cap) throw Error('meal invalid public observation budget');
  }
  const observer = { original, listeners: [], workers: [], messages: [], failures: [], rejections: [], soundSentinelCount: 0, identities, limit, stopped: false,
    limits: { messages: limit, workers: 8, publicMessageByteUpperBound: maxBytes, nodes: maxNodes, records: maxRecords, depth: 64 },
    retained: { publicMessageByteUpperBound: 0, nodes: 0, records: 0 } };
  // Conservative compact-JSON cost upper bound checked BEFORE cloning. No reference to the delivered object is retained.
  const measure = (message, worker) => {
    const cost = { publicMessageByteUpperBound: 0, nodes: (message.t === 'snapshot' ? message.s?.nodes : message.p?.nodes)?.length ?? 0, records: 0 };
    const ancestors = new Set(); let soundSentinelCount = 0;
    const charge = (bytes, records = 0) => {
      cost.publicMessageByteUpperBound += bytes; cost.records += records;
      if (observer.retained.publicMessageByteUpperBound + cost.publicMessageByteUpperBound > maxBytes) throw Error('meal public archive byte limit exceeded');
      if (observer.retained.records + cost.records > maxRecords) throw Error('meal public record limit exceeded');
    };
    if (observer.retained.nodes + cost.nodes > maxNodes) throw Error('meal public node limit exceeded');
    const visit = (v, depth, path) => {
      if (depth > bounds.depth) throw Error('meal public record depth limit exceeded');
      charge(4,1);
      if (v === null || typeof v === 'boolean') { charge(5); return; }
      if (typeof v === 'string') { charge(v.length*6+2); return; }
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) {
          // Existing sound-record.ts projects nonnumeric field changes to NaN. No other public number is exempt.
          const row = message.t === 'part' && path.length === 4 && path[0] === 'p' && path[1] === 'happened'
            && /^(0|[1-9][0-9]*)$/.test(path[2]) && path[3] === 'to' && Array.isArray(message.p?.happened)
            ? message.p.happened[Number(path[2])] : null;
          if (Number.isNaN(v) && row && !Array.isArray(row) && Number.isFinite(row.at)
            && typeof row.node === 'string' && row.node.length > 0 && Number.isSafeInteger(row.field) && row.field >= 0
            && Object.hasOwn(row, 'to') && !Object.hasOwn(row, 'name')) {
            soundSentinelCount++; charge(128); return;
          }
          const keys = path.map(key => key.slice(0, 128));
          const diagnostic = { worker, category: message.t, path: keys, pathTruncated: path.some((key,i) => key !== keys[i]),
            valueType: 'number', nonfinite: Number.isNaN(v) ? 'NaN' : v > 0 ? 'positive Infinity' : 'negative Infinity' };
          const error = Error('meal unsupported public nonfinite number: ' + JSON.stringify(diagnostic));
          error.mealDiagnostic = diagnostic; throw error;
        }
        charge(32); return;
      }
      if (typeof v === 'bigint') { charge(String(v).length+100); return; }
      if (v === undefined) { charge(100); return; }
      if (v instanceof Uint8Array) { charge(v.length*4+100,v.length); return; }
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) throw Error('meal unsupported public binary type');
      if (typeof v !== 'object' || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) throw Error('meal unsupported public value type');
      if (ancestors.has(v)) throw Error('meal unsupported public cyclic record');
      if (Array.isArray(v) && observer.retained.records + cost.records + v.length > maxRecords) throw Error('meal public record limit exceeded');
      ancestors.add(v); let arrayKeys = 0;
      for (const key in v) if (Object.hasOwn(v,key)) {
        if (Array.isArray(v) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) throw Error('meal unsupported public array property');
        arrayKeys++; charge(key.length*6+4); visit(v[key],depth+1,[...path,key]);
      }
      if (Array.isArray(v) && arrayKeys !== v.length) throw Error('meal unsupported public sparse array');
      ancestors.delete(v);
    };
    visit(message,0,[]); return {cost, soundSentinelCount};
  };
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
          if (!payload) return; // Other public message types are explicitly outside this snapshot/part archive.
          if (payload.nodes !== undefined && !Array.isArray(payload.nodes)) throw Error('meal malformed public node list');
          if (observer.messages.length >= limit) throw Error('meal public payload storage limit exceeded');
          const {cost, soundSentinelCount} = measure(message, worker.number), publicMessage = structuredClone(message);
          if (message.t === 'snapshot') worker.latest.clear();
          const removed = (payload.removed ?? []).filter(id => known.has(id));
          for (const id of removed) worker.latest.delete(id);
          const nodes = (payload.nodes ?? []).filter(n => known.has(n.id)).map(n => copy(Object.fromEntries(
            ['id', 'kind', 'parent', 'slot', 'pos', 'rot', 'at', 'body', 'slots', 'fields'].filter(k => n[k] !== undefined).map(k => [k, n[k]]))));
          for (const node of nodes) worker.latest.set(node.id, node);
          worker.worldAt = Number.isSafeInteger(payload.to) ? payload.to : null;
          for (const key of Object.keys(cost)) observer.retained[key] += cost[key];
          observer.soundSentinelCount += soundSentinelCount;
          observer.messages.push({ soundSentinelCount, worker: worker.number, receivedAt: performance.now(), worldAt: worker.worldAt, type: message.t, nodes, removed, publicMessage });
        } catch (error) {
          if (observer.failures.length < 10) { observer.failures.push(String(error)); if (error.mealDiagnostic) observer.rejections.push(error.mealDiagnostic); }
        }
      };
      this.addEventListener('message', listener); observer.listeners.push([this, listener]);
    }
  }
  observer.wrapped = ObservedWorker; window.__mealPayloadObserver = observer; window.Worker = ObservedWorker;
}

/** Serialized page read, deliberately separate native observation and depicted clocks. No hand labels inferred. */
/** Actual public hash plus verified companion mapping, and an independent default-body negative control. */
export function mealBodyReadiness({declared,defaultBody,soul,defaultSoul,expected}) {
  const observer=window.__mealPayloadObserver,world=window.__soulsEntity;if(!observer||!world?.gameFrame)return null;
  if(observer.failures.length)throw Error(observer.failures.join('; '));
  const frame=world.gameFrame(),person=(who)=>{const people=frame.souls?.filter(s=>s.id===who)??[];return people.length===1?frame.entities?.[people[0].entityId]:null;};
  const actual=person(soul)?.state?.body,control=person(defaultSoul)?.state?.body;
  const workers=observer.workers.filter(w=>w.latest.get(declared)?.body===expected.hash&&w.latest.has(defaultBody));if(workers.length!==1)return null;
  const raw=workers[0].latest.get(declared),negative=workers[0].latest.get(defaultBody);
  if(negative.body!==undefined||control?.nativeResources!==undefined||control?.nativeKindHash!==undefined)return null;
  if(actual?.nativeBody!==declared||actual?.nativeKindHash!==expected.hash||JSON.stringify(actual?.nativeResources)!==JSON.stringify(expected.resources))return null;
  return {preset:expected.preset,nativeHash:raw.body,depictedHash:actual.nativeKindHash,resources:actual.nativeResources,
    defaultControl:{nativeHash:negative.body??null,resources:control?.nativeResources??null},
    qualification:'Declared-body metadata observed; default-body mapping remains unknown. No physical contact claim.'};
}

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
    return observer.result = { messages: observer.messages, failures: observer.failures, rejections: observer.rejections, soundSentinelCount: observer.soundSentinelCount, identities: observer.identities, limit: observer.limit, limits: observer.limits, retained: observer.retained,
      qualification: 'Full passive structured-cloned snapshot/part messages with original emitted names/types, including moves, runEnds, samples, courses, leaves, chair/ancestor nodes and unknown fields; other message types (pointer/error/format/catching) are not archived. Only the documented nonnumeric field-change NaN at part.happened[].to is accepted and counted; other nonfinite public values remain rejected. Private JSON tags preserve Number/BigInt/Uint8Array/undefined and escape literal tag objects; tags are not native protocol fields. Selected nodes/latest retain legacy checkpoint semantics. Byte budget bounds public message trees by conservative compact-JSON cost; legacy selected views, envelope metadata and JSON indentation add overhead, so this is not pretty-printed file size. No contact/final-draw or missing-native-capability claim.' };
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
  const identities = { bowl: mealNodeIdentity(state.bowl), bodies: state.seats.map(s => mealNodeIdentity(s.body)) };
  await page.addInitScript(mealBrowserInstall, { bowl: identities.bowl.worker, bodies: identities.bodies.map(i => i.worker), identities });
  state.installed = true;
  mealFinalization(page, paths, state);
  return async () => { try { if (!page.isClosed()) await state.finalize(); } finally { state.persist(); states.delete(paths.dir); } };
}

export default async function ({ page, paths, check, expectHttp, signal }) {
  const state = states.get(paths.dir); assert(state, 'meal preparation missing');
  expectHttp('/safety.md', 404, 'The old-page fixture does not route this optional standalone client document.');
  const url = new URL(page.url()); url.search = 'post=0&hour=12:00&eye=9,6,1.5&at=0,0.8,1.5';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.viewer-history[data-viewer-ready="true"]') && !document.querySelector('.viewer-arrival'), null, { timeout: 30000 });
  const snapshot = async label => writeFileSync(join(paths.dir, `meal-accessibility-${label}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  await nativeCameraMode(page, 'manual', snapshot); await page.keyboard.press('Escape');
  assert(await page.evaluate(() => !!window.__mealPayloadObserver), 'meal observer not installed'); state.installed = true;
  if(state.declaredBody){
    const handle=await page.waitForFunction(mealBodyReadiness,{declared:mealNodeIdentity(state.seats[2].body).worker,defaultBody:mealNodeIdentity(state.seats[0].body).worker,soul:state.seats[2].soul,defaultSoul:state.seats[0].soul,expected:state.declaredBody},{timeout:8000});
    state.bodyReadiness=await handle.jsonValue();await handle.dispose();save(paths,'command-meal-body-readiness.json',{wear:state.declaredBody,observed:state.bodyReadiness});
    check('meal-declared-body-and-default-control',!!state.bodyReadiness,state.bodyReadiness);
  }

  const observe = async row => {
    signal.throwIfAborted();
    const seat = state.seats.find(s => s.label === row.role);
    const identities = { bowl: mealNodeIdentity(state.bowl), holder: mealNodeIdentity(row.holder) };
    const handle = await page.waitForFunction(mealCheckpoint, { bowl: identities.bowl.worker, holder: identities.holder.worker, soul: seat.soul, soup: row.soup, phase: row.phase }, { timeout: 5000 });
    const checkpoint = await handle.jsonValue(); await handle.dispose();
    checkpoint.identities = identities;
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
