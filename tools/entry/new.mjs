#!/usr/bin/env node
// Scaffold a new kind (0.135 R6, #4045): one command writes a kind's entry and its two slimmed case files in the places
// the existing kinds use, and all three pass the checks as written.
//
//   node tools/entry/new.mjs <family> <kind> [--root <dir>]
//
// <family> is a folder of content/kinds (made if new, words joined by `-`); <kind> is the kind's name, words joined by
// `_`, made `eden:<kind>`. Writes, and refuses to overwrite:
//   content/kinds/<family>/<kind>.json             the entry: one on/off field and two forms that set it
//   packages/form-rules/cases/<kind>.json          the rules cases: a yes per form and a refusal per need
//   packages/form-rules/cases/effects/<kind>.json  the effects case: one run through the forms
// The skeleton is a switch, the smallest kind with a way out of every need; the recipe in RUBRIC.md ("A new kind") says
// what to replace. `--root` writes under another checkout (the command's own test). Prints one JSON line.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMain} from '../lib/is-main.mjs';
import {loadDir} from './format.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FAMILY = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const KIND = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Where the three files of `<family> <kind>` go under `root`. */
export function paths(root, family, kind) {
  return {
    entry: join(root, 'content/kinds', family, `${kind}.json`),
    rules: join(root, 'packages/form-rules/cases', `${kind}.json`),
    effects: join(root, 'packages/form-rules/cases/effects', `${kind}.json`),
  };
}

/** The three documents, as JSON values. */
export function scaffold(family, kind) {
  const id = `eden:${kind}`;
  const words = kind.replace(/_/g, ' ');
  const about = `${words} (${family}), scaffolded by tools/entry/new.mjs: a switch to replace with the kind's own forms; keep a yes per form (at most four), a refusal per need and one effects run through the main chain, 12 KB in all.`;
  const form = (on) => ({
    who: 'anyone',
    starts: 'act',
    needs: [{need: 'state', field: 'on', is: !on}, {need: 'within_reach', point: 'switch'}],
    steps: [{step: 'move', move: 'press', at: 'switch'}],
    effects: [{change: 'set', field: 'on', to: on, event: on ? 'switched_on' : 'switched_off'}],
  });
  const entry = {
    format: 'souls-entry/1',
    kind: id,
    owner: 'thing',
    state: {on: {n: 28, type: 'bool', default: false, audience: {rule: 'everyone'}}},
    points: {switch: {role: 'contact', at_mm: [0, 300, 105]}},
    geometry: {bounds_mm: [240, 600, 240]},
    forms: {switch_on: form(true), switch_off: form(false)},
    motion: {how: 'fixed'},
    loose: {ever: true},
    looks: {shape: {round: 0, shapes: [{kind: 'box', at: [0, 300, 0], size: [240, 600, 240], tint: 'body'}], palette: {body: '#8a8f86'}, tags: ['object']}},
    text: {card: `A ${words} to switch on and off.`, thing: 'thing', name: words},
    card: {text: 'card', category: 'thing', synonyms: ['name']},
  };
  const node = (on) => ({kind: id, fields: {on}});
  const body = (z) => ({hands: {left: null, right: null}, effector_mm: [0, 300, z]});
  const moves = {press: {reach_mm: 600}};
  const rule = (name, formName, on, z, expect) => ({name: `${kind}/${name}`, act: {this: 't1', form: formName}, state: {actor: 'b1', nodes: {t1: node(on), b1: body(z)}, moves}, asker: {sees: 'all'}, expect});
  const rules = {
    format: 'souls-form-cases/1',
    about,
    cases: [
      rule('switch_on', 'switch_on', false, 305, {verdict: 'yes'}),
      rule('switch_off', 'switch_off', true, 305, {verdict: 'yes'}),
      rule('switch_on_when_on', 'switch_on', true, 305, {verdict: 'no', reason: 'field_differs', need: 0, fix: {form: 'switch_off'}}),
      rule('switch_on_out_of_reach', 'switch_on', false, 3105, {verdict: 'no', reason: 'out_of_reach', need: 1, fix: {step: 'walk_to', point: 'switch'}}),
      rule('switch_off_when_off', 'switch_off', false, 305, {verdict: 'no', reason: 'field_differs', need: 0, fix: {form: 'switch_on'}}),
      rule('switch_off_out_of_reach', 'switch_off', true, 3105, {verdict: 'no', reason: 'out_of_reach', need: 1, fix: {step: 'walk_to', point: 'switch'}}),
    ],
  };
  const set = (to, n) => ({verdict: 'yes', changes: [{change: 'set', node: 't1', field: 'on', n: 28, to: to ? 1 : 0}], events: [{event: `eden:switched_${to ? 'on' : 'off'}`, node: 't1', changes: [0]}], receipt: `${kind}${n}`});
  const effects = {
    format: 'souls-effect-cases/1',
    about,
    cases: [{
      name: `${kind}/switch_on_then_off`,
      state: {actor: 'b1', nodes: {room: {loose: ['b1', 't1']}, t1: {kind: id}, b1: body(305)}, moves},
      do: [
        {act: {this: 't1', form: 'switch_on'}, receipt: `${kind}0`, expect: set(true, 0)},
        {act: {this: 't1', form: 'switch_off'}, receipt: `${kind}1`, expect: set(false, 1)},
      ],
      after: {t1: {kind: id, fields: {on: 0}}},
    }],
  };
  return {entry, rules, effects};
}

/** Write the three files under `root`; returns {ok, files} or {ok: false, error}. Writes nothing on a refusal. */
export function create(family, kind, root = ROOT) {
  if (!FAMILY.test(family ?? '')) return {ok: false, error: `family "${family}": lower-case words joined by "-"`};
  if (!KIND.test(kind ?? '')) return {ok: false, error: `kind "${kind}": lower-case words joined by "_"`};
  const at = paths(root, family, kind);
  const taken = Object.values(at).find(existsSync);
  if (taken) return {ok: false, error: `${relative(root, taken)} exists; pick another kind name`};
  const kindsDir = join(root, 'content/kinds');
  const clash = existsSync(kindsDir) && loadDir(kindsDir).find(f => { try { return JSON.parse(readFileSync(f, 'utf8')).kind === `eden:${kind}`; } catch { return false; } });
  if (clash) return {ok: false, error: `eden:${kind} is already defined in ${relative(root, clash)}`};
  const docs = scaffold(family, kind);
  for (const [k, file] of Object.entries(at)) {
    mkdirSync(dirname(file), {recursive: true});
    // The entry is written as the entries are (two-space JSON); the case files on one line, as the slimmed kinds' are.
    writeFileSync(file, (k === 'entry' ? JSON.stringify(docs[k], null, 2) : JSON.stringify(docs[k])) + '\n');
  }
  return {ok: true, kind: `eden:${kind}`, files: Object.values(at).map(f => relative(root, f))};
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const r = args.indexOf('--root');
  const root = r >= 0 ? args.splice(r, 2)[1] : ROOT;
  const [family, kind, extra] = args;
  const out = extra === undefined ? create(family, kind, root) : {ok: false, error: 'usage: node tools/entry/new.mjs <family> <kind> [--root <dir>]'};
  console.log(JSON.stringify(out.ok ? {...out, next: `node tools/entry/check.mjs ${family} && node --test packages/form-rules/src/*.test.ts`} : out));
  process.exitCode = out.ok ? 0 : 2;
}
