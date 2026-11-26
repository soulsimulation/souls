#!/usr/bin/env node
// A three-Soul camp meal using existing entries and each Soul's own served client. Cook and ladle are waits with
// quantity changes, not stirring or pouring animations. The sink wash spends water; soup bowls have no dirt field.
//
//   node tools/playtest/meal/meal.mjs scene --dir .local/meal
//   node tools/playtest/meal/meal.mjs run --page <old-page world URL> --directory <directory URL>
//     --gateway <gateway WebSocket URL> --world-page <native world URL> --world dev --dir .local/meal-run --pkg <replica package>
//
// Start the generated template/facts with arena/new-engine/old-page.mjs. On a farm set V2_BIN to an existing release
// build; this helper never invokes cargo. Output contains private local transport details and is never published raw.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { isMain } from '../../lib/is-main.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { defOf } from '../../entry/look.mjs';
import { pairSeat, lastJson } from '../arena/new-engine/seat.mjs';

export const ENTRIES = ['food/camp_soup_pot', 'food/soup_bowl', 'kitchen/sink', 'furniture/table', 'seating/chair'];
export const LABELS = ['cook', 'server', 'diner'];
export const CAMERA = { eye: [7, 5, 9], at: [0, 0.8, 1.5] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const execute = promisify(execFile);
const TABLE_PHYSICAL = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/world-compiler/src/core-kit/furniture.json'), 'utf8')).find((d) => d.name === 'core-table');

/** Existing entry shapes, state defaults and declared slots; the scene adds no action or changed kind meaning. */
export function sceneOf(entries) {
  const definitions = entries.map((entry, i) => {
    const def = defOf(entry);
    if (!def) throw new Error(`no existing shape for ${entry.kind}`);
    def.name = `meal-${entry.kind.split(':')[1].replaceAll('_', '-')}`;
    def.slots = Object.entries(entry.slots ?? {}).map(([id, s]) => ({ id, kind: s.admits === 'body' ? 'seat' : 'shelf',
      p: s.at_mm.map((x) => x / 1000), yaw: (s.yaw_mdeg ?? 0) * Math.PI / 180000,
      accepts: {}, capacity: s.most, ...(s.admits === 'body' ? { height: s.at_mm[1] / 1000 } : {}) }));
    // The gallery shape omits physical surface metadata: retain the canonical table's existing top slot/components.
    // This adds no collider and does not repair the observed body/tabletop intersection.
    if (entry.kind === 'eden:table') {
      def.components = structuredClone(TABLE_PHYSICAL.components);
      def.slots.push(...structuredClone(TABLE_PHYSICAL.slots).filter((s) => !def.slots.some((own) => own.id === s.id)));
    }
    return { entry, def, ref: `${def.name}@1`, i };
  });
  const [pot, bowl, sink, table, chair] = definitions;
  return {
    template: { schema: 'genesis/1', name: 'Shared camp meal', constants: { extent: 80, ground: 'land' }, batches: [{ note: 'Existing kitchen and dining shapes', ops: [
      ...definitions.map(({ def }) => ({ op: 'define', def })),
      { op: 'place', def: pot.ref, name: 'soup-pot', tmp: '$pot', p: [-3, 0] },
      { op: 'place', def: bowl.ref, name: 'meal-bowl', in: { parent: '$pot', slot: 'shelf' }, p: [0, 0, 0] },
      { op: 'place', def: sink.ref, name: 'wash-sink', p: [3, 0] },
      { op: 'place', def: table.ref, name: 'meal-table', p: [0, 3] },
      { op: 'place', def: chair.ref, name: 'diner-chair', p: [0, 4.1], r: Math.PI },
    ] }] },
    map: { format: 'souls-world-map/1', rows: definitions.map(({ entry, ref }) => ({ def: ref, entry: entry.kind, kind: entry.kind })) },
  };
}

export function writeScene(dir) {
  mkdirSync(dir, { recursive: true });
  const entries = ENTRIES.map((p) => JSON.parse(readFileSync(join(REPO_ROOT, 'content/kinds', p + '.json'), 'utf8')));
  const scene = sceneOf(entries), template = join(dir, 'meal.json'), map = join(dir, 'meal-map.json'), facts = join(dir, 'meal.facts.json');
  writeFileSync(template, JSON.stringify(scene.template)); writeFileSync(map, JSON.stringify(scene.map));
  execFileSync(process.execPath, [join(REPO_ROOT, 'v2/tools/import-eden/export/export.ts'), '--template', template, '--map', map, '--out', facts], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return { template, map, facts };
}

/** Use only a thing learned from this Soul's current copy; no template id is treated as a native node id. */
export function foundId(answer, name) {
  const rows = (answer.found ?? []).filter((r) => r.name === name);
  if (rows.length !== 1) throw new Error(`find ${name}: expected one named thing, got ${rows.length}`);
  return rows[0].id;
}
export function requireDone(answer, step) {
  if (answer.ok !== true || answer.phase !== 'done') throw Object.assign(new Error(`${step}: ${answer.code ?? answer.reason ?? answer.phase ?? 'no completed receipt'}`), { answer, step });
  return answer;
}
export function requireField(answer, field, expected, step) {
  const read = answer.state?.[field] ?? answer.fields?.[field];
  // Captured entry defaults may be integer 0/1 in inspect; changed fields may be actual booleans.
  const actual = typeof expected === 'boolean' && (read === 0 || read === 1) ? read === 1 : read;
  if (actual !== expected) throw Object.assign(new Error(`${step}: ${field} expected ${expected}, got ${JSON.stringify(actual)}`), { answer, step });
}

/** A sent sequence is not success: only the last authoritative receipt can finish a non-act command. */
export function terminalReceipt(answer) {
  const last = answer.receipt?.answers?.at(-1);
  if (!last || !['receipt', 'refused', 'ended'].includes(last.answer)) return null;
  return { ...answer, ok: last.answer === 'receipt', phase: last.answer === 'receipt' ? 'done' : last.answer, code: last.reason, detail: last.detail };
}

/** One isolated home per role, paired normally, then the exact client served by the world drives every command. */
export async function servedSeats({ world, page, dir, pkg }) {
  const source = await fetch(new URL('eden.mjs', page)).then(async (r) => { if (!r.ok) throw new Error(`served client ${r.status}`); return r.text(); });
  const seats = [];
  for (const label of LABELS) {
    const seat = await pairSeat({ world, dir, label, name: label[0].toUpperCase() + label.slice(1), pkg });
    const client = join(seat.folder, 'eden.mjs'); writeFileSync(client, source);
    const run = async (...words) => {
      const start = Date.now(), r = await execute(process.execPath, [client, ...words, '--soul', seat.soul], { cwd: seat.folder,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SOULS_HOME: seat.home, SOULS_REPLICA_PKG: pkg, BRAIN_MODE: 'fake' }, timeout: 120000, maxBuffer: 8e6 });
      const answer = lastJson(r.stdout) ?? { ok: false, code: 'not-json' };
      appendFileSync(join(dir, 'meal-commands-private.jsonl'), JSON.stringify({ label, start, ms: Date.now() - start, words, answer }) + '\n');
      return answer;
    };
    seats.push({ ...seat, run });
  }
  return seats;
}

/** Fail on the first refusal or missing quantity/ownership proof; never use creator edits to repair the scene. */
export async function meal({ seats, report, log = () => {} }) {
  const [cook, server, diner] = seats;
  const record = async (seat, label, ...words) => { const a = await seat.run(...words); report.steps.push({ role: seat.label, label, answer: a }); log(`${seat.label}: ${label} -> ${a.phase ?? (a.ok ? 'ok' : a.code)}`); return a; };
  const act = async (seat, label, ...words) => requireDone(await record(seat, label, 'act', ...words, '--wait'), label);
  for (const seat of seats) {
    const status = await record(seat, 'arrival status', 'status');
    if (status.ok !== true) throw Object.assign(new Error(`arrival status: ${status.code ?? 'failed read'}`), { answer: status, step: 'arrival status' });
    if (!status.in_world || !status.body) await act(seat, 'join', 'life:join');
  }
  const ids = {};
  for (const name of ['soup-pot', 'meal-bowl', 'wash-sink', 'meal-table', 'diner-chair']) ids[name] = foundId(await record(cook, `find ${name}`, 'find', name), name);
  const inspect = (seat, name) => record(seat, `inspect ${name}`, 'inspect', ids[name]);
  const before = await inspect(cook, 'soup-pot');
  for (const [field, expected] of Object.entries({ soup: 0, vegetables: 3, water: 1500, fuel: 1, cooked: false })) requireField(before, field, expected, 'raw pot');
  await act(cook, 'cook (ten-second wait)', `cook:${ids['soup-pot']}`);
  const cooked = await inspect(cook, 'soup-pot');
  for (const [field, expected] of Object.entries({ soup: 6, vegetables: 0, water: 0, fuel: 0, cooked: true })) requireField(cooked, field, expected, 'cooked pot');
  await act(cook, 'leave the serving point', `walk:${ids['meal-table']}`);
  await act(server, 'ladle two units (four-second wait)', `ladle:${ids['soup-pot']}`, `bowl=${ids['meal-bowl']}`);
  requireField(await inspect(server, 'soup-pot'), 'soup', 4, 'served pot');
  requireField(await inspect(server, 'meal-bowl'), 'soup', 2, 'filled bowl');
  await act(server, 'approach bowl', `walk:${ids['meal-bowl']}`);
  await act(server, 'take filled bowl', `take:${ids['meal-bowl']}`);
  const dinerBody = (await record(diner, 'body', 'status')).body;
  await act(diner, 'approach server', `walk:${(await record(server, 'body', 'status')).body}`);
  await record(server, 'offer bowl', 'give', ids['meal-bowl'], '--to', dinerBody);
  let offer;
  for (let n = 0; n < 10 && !offer; n++) {
    const answer = await record(diner, 'read bowl offer', 'wait', '1');
    offer = answer.give?.offer ?? answer.events?.find((e) => e.kind === 'give' && e.what === 'offered')?.offer;
  }
  if (!offer) throw new Error('give offer not observed by diner');
  requireDone(await record(diner, 'accept bowl', 'give', 'accept', offer, '--wait'), 'accept bowl');
  const heldBowl = await inspect(diner, 'meal-bowl');
  if (heldBowl.parent !== dinerBody) throw new Error('accepted bowl is not parented to the diner');
  await act(diner, 'carry bowl to chair', `walk:${ids['diner-chair']}`);
  await act(diner, 'sit holding bowl', `sit:${ids['diner-chair']}`);
  for (const expected of [1, 0]) {
    await act(diner, 'consume one soup unit', `bite:${ids['meal-bowl']}`);
    requireField(await inspect(diner, 'meal-bowl'), 'soup', expected, 'bowl consumed');
  }
  await act(diner, 'rise holding empty bowl', 'rise');
  await act(diner, 'carry empty bowl to sink', `walk:${ids['wash-sink']}`);
  await act(diner, 'turn on tap', `turn_on:${ids['wash-sink']}`);
  const water = await inspect(diner, 'wash-sink');
  await act(diner, 'wash same held bowl', `wash:${ids['wash-sink']}`, `thing=${ids['meal-bowl']}`);
  requireField(await inspect(diner, 'wash-sink'), 'water', (water.state?.water ?? water.fields?.water) - 1000, 'wash water used');
  await act(diner, 'turn off tap', `turn_off:${ids['wash-sink']}`);
  await act(diner, 'return empty bowl to table', `walk:${ids['meal-table']}`);
  const setDown = await record(diner, 'set down empty bowl', 'set-down', ids['meal-bowl'], 'on', ids['meal-table']);
  if (setDown.ok === false || !Number.isInteger(setDown.sequence)) throw new Error('set-down sent no sequence');
  let finished = null;
  for (let n = 0; n < 40 && !finished; n++) {
    finished = terminalReceipt(await record(diner, 'read set-down receipt', 'receipt', String(setDown.sequence)));
    if (!finished) await sleep(100);
  }
  requireDone(finished ?? {}, 'set down empty bowl');
  const finalBowl = await inspect(diner, 'meal-bowl');
  if (finalBowl.parent !== ids['meal-table']) throw new Error('empty bowl was not left on the meal table');
  requireField(finalBowl, 'soup', 0, 'empty bowl returned');
  requireField(await inspect(cook, 'soup-pot'), 'soup', 4, 'food conserved');
  report.quantities = { cooked: 6, remaining: 4, eaten: 2, washWaterUsed: 1000 };
  report.complete = true; report.limitations = ['Cook and ladle contain waits, with no stir/pour moves.', 'The sink wash spends water but soup bowls have no persistent dirt/clean state.', 'Natural holding, consumption and furniture clearance require the accompanying actual-page review.'];
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const command = args.shift(), opt = (name) => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; }, dir = resolve(opt('dir') ?? '.local/meal');
  if (command === 'scene') { console.log(JSON.stringify(writeScene(dir))); return; }
  if (command !== 'run') throw new Error('scene --dir, or run --page --directory --gateway --world --dir --pkg');
  mkdirSync(dir, { recursive: true });
  const world = { world: opt('world') ?? 'dev', page: opt('world-page') ?? opt('page'), directory: opt('directory'), gateway: opt('gateway') }, pkg = resolve(opt('pkg'));
  const report = { complete: false, steps: [] }; let seats = [];
  try { seats = await servedSeats({ world, page: opt('page'), dir, pkg }); await meal({ seats, report, log: console.log }); }
  catch (e) { report.failure = { step: e.step, message: e.message, answer: e.answer }; process.exitCode = 1; }
  finally { for (const seat of seats) await seat.run('quit').catch(() => {}); writeFileSync(join(dir, 'meal-report-private.json'), JSON.stringify(report, null, 2)); }
}
if (isMain(import.meta.url)) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
