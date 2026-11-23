#!/usr/bin/env node
// The validator for moves (Soul Actions SA-D4, #2856): a hand's action as data, in content/moves/<name>.json.
//
//   node tools/entry/move.mjs [content/moves]     validate every move; prints each one's provisional reference
//
// A move states what it claims on the body (by resource class, never anatomy: contract T9), what it blocks and what
// cancels it, its effector and reach in whole millimetres, and its phases in whole microseconds. Contact is the one
// instant at the end of start-up; a pour has a contact window (`pour_us`) after it. The effector `held_point` is a named
// point of the thing in the hand (a spout): reach is measured from it, not from the hand. Nothing is counted in ticks and no number is floating-point. Where the hand is at a
// time is `pose.mjs`. This file reads `format.mjs` and changes nothing in it.
import { isMain } from '../lib/is-main.mjs';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseEntry, canonical} from './format.mjs';

export const MOVE_FORMAT = 'souls-move/1';
export const RESOURCE_CLASSES = Object.freeze(['locomotion', 'manipulator', 'gaze', 'voice']);
export const CANCELS_ON = Object.freeze(['claim_taken', 'out_of_reach']);
export const EFFECTORS = Object.freeze(['hand', 'held_point']);
export const PHASES = Object.freeze(['start_up_us', 'slide_us', 'pour_us', 'consume_us', 'strike_us', 'pump_us', 'recovery_us']);
export const REACH_MAX_MM = 700;
const KEYS = ['format', 'move', 'claims', 'blocks', 'cancels_on', 'effector', 'reach_mm', 'contact', 'phases'];
const IDENT = /^[a-z][a-z0-9_]*$/;
const TICK = /(?:^|[_\W])[Tt]icks?(?:$|[_\W])|[a-z]Ticks?\b/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate one move record. Returns `{path, reason}` items; an empty list means it is accepted. */
export function validateMove(m) {
  const errors = [];
  const err = (path, reason) => errors.push({path, reason});
  if (!isObj(m)) return [{path: '', reason: 'a move is a table'}];
  const scan = (v, path) => {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) err(path, `a floating-point number (${v}); write a whole number in stated units`);
    else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}.${i}`));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) {
      if (TICK.test(k)) err(`${path}.${k}`.replace(/^\./, ''), 'nothing is counted in ticks; durations are microseconds');
      scan(x, `${path}.${k}`.replace(/^\./, ''));
    }
  };
  scan(m, '');
  for (const k of Object.keys(m)) if (!KEYS.includes(k)) err(k, `unknown key; expected ${KEYS.join(', ')}`);
  if (m.format !== MOVE_FORMAT) err('format', `must be ${MOVE_FORMAT}`);
  if (typeof m.move !== 'string' || !IDENT.test(m.move)) err('move', 'a lower_snake_case name');
  for (const key of ['claims', 'blocks']) {
    const list = m[key];
    if (!Array.isArray(list) || list.length === 0) { err(key, 'a list of resource classes'); continue; }
    list.forEach((c, i) => { if (!RESOURCE_CLASSES.includes(c)) err(`${key}.${i}`, `one of ${RESOURCE_CLASSES.join(', ')} (a class, never anatomy)`); });
  }
  if (!Array.isArray(m.cancels_on)) err('cancels_on', 'a list');
  else m.cancels_on.forEach((c, i) => { if (!CANCELS_ON.includes(c)) err(`cancels_on.${i}`, `one of ${CANCELS_ON.join(', ')}`); });
  if (!EFFECTORS.includes(m.effector)) err('effector', `one of ${EFFECTORS.join(', ')}`);
  // `contact` (optional): the named point of the thing or body it reaches, fixed by the move (a handshake reaches the
  // other's right hand); with none, the form's step names it (`at`).
  if (m.contact !== undefined && (typeof m.contact !== 'string' || !IDENT.test(m.contact))) err('contact', 'a lower_snake_case point name');
  if (!(Number.isSafeInteger(m.reach_mm) && m.reach_mm > 0 && m.reach_mm <= REACH_MAX_MM)) err('reach_mm', `whole millimetres, 1 to ${REACH_MAX_MM} (under a full arm)`);
  if (!isObj(m.phases)) err('phases', 'a table of phase lengths in microseconds');
  else {
    for (const k of Object.keys(m.phases)) if (!PHASES.includes(k)) err(`phases.${k}`, `unknown phase; durations are named ${PHASES.join(', ')} (microseconds, never ticks)`);
    for (const k of ['start_up_us', 'recovery_us']) if (m.phases[k] === undefined) err(`phases.${k}`, 'required');
    for (const [k, v] of Object.entries(m.phases)) if (!(Number.isSafeInteger(v) && v > 0)) err(`phases.${k}`, 'whole microseconds above zero');
  }
  if (isObj(m.phases) && ['slide_us', 'pour_us', 'consume_us', 'strike_us', 'pump_us'].filter(k => m.phases[k] !== undefined).length > 1) err('phases', 'a move slides, pours, consumes, strikes or pumps, not more than one');
  if (isObj(m.phases) && m.phases.consume_us !== undefined && !(Array.isArray(m.claims) && m.claims.includes('voice'))) err('claims', 'a move that consumes claims the mouth (voice)');
  if (isObj(m.phases) && (m.phases.pour_us !== undefined || m.phases.consume_us !== undefined || m.phases.strike_us !== undefined || m.phases.pump_us !== undefined) && m.effector !== 'held_point') err('effector', "a pour's, consume's, strike's or pump's effector is a point of the held thing (held_point)");
  return errors;
}

/** Whether a move takes a second point (a slide ends somewhere else). */
export const slides = m => m.phases.slide_us !== undefined;

/** The provisional reference of a move: `<name>@prov-1220<sha-256>`. Changes once with Engine v2's encoding (T0). */
export function refOf(m) {
  return `${m.move}@prov-1220${createHash('sha256').update('souls/move/provisional/1\n' + canonical(m)).digest('hex')}`;
}

/** Load and validate every move in a folder. */
export function loadMoves(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const {entry, errors} = parseEntry(readFileSync(join(dir, f), 'utf8'));
    const all = [...errors, ...(entry === undefined ? [] : validateMove(entry))];
    if (entry && entry.move !== f.slice(0, -5)) all.push({path: 'move', reason: 'the name matches the file name'});
    out.push({file: f, move: entry, ref: entry && all.length === 0 ? refOf(entry) : undefined, errors: all});
  }
  return out;
}

if (isMain(import.meta.url)) {
  const dir = process.argv[2] ?? 'content/moves';
  let bad = 0;
  for (const r of loadMoves(dir)) { console.log(JSON.stringify({file: r.file, ref: r.ref, errors: r.errors})); bad += r.errors.length; }
  process.exit(bad ? 1 : 0);
}
