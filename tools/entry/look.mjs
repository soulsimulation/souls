#!/usr/bin/env node
// The look gate for things (Soul Actions SA-P4, #2863): a picture of a kind in every state it declares.
//
//   node tools/entry/look.mjs <family|folder|file> [--root content/kinds] [--out <dir>] [--kind <name>] [--plan]
//
// Writes one sheet per kind, <out>/<namespace>-<name>/sheet.png: the kind drawn once in its default state, then once per
// other value of each state field, one field varied at a time, the rest left at their defaults, with the kind's points
// (and slots) marked over it. A kind with no state fields is one frame. It runs headless (the library gallery's studio page
// in headless Chrome, tools/god-skill/scripts/gallery.mjs) and prints one JSON line per kind: its sheet, frames and errors.
// With --plan it prints the frames it would draw and renders nothing. Sheets are attached to a pull request, never committed.
//
// What the picture is drawn from: `looks.shape` of the entry, the parts of a thing (round, shapes, palette, tags) written in whole millimetres
// (the format has no floating-point number and names nothing of today's engine, #2855). look.mjs wraps it for today's studio
// and converts it to metres when it is
// drawn: a length (at, size, r, r2, h, round, the points of a profile, a path or a polygon) is divided by 1000, an angle
// (roll, arc, yaw, pitch) is whole millidegrees and becomes radians, a part's stretch (scale) and its own glow are permille
// and become fractions, a count (segments) stays. A number under any other key is refused by name, so a unit is never
// guessed. A text, list or schedule field changes no part, so it is neither a frame nor a state of the drawn def. A state value the entry holds as a whole number reaches the picture as the number
// the viewer draws with (permille / 1000); the viewer, not the entry, uses fractions, and nothing here decides anything
// from them. A kind whose shape is missing is reported, not drawn. SA-D1a owns the rest of the looks table.
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDir, parseEntry, validateEntry} from './format.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARK_ROLES = ['stand', 'grip', 'contact', 'outlet', 'slot'];
const LEGEND = 'points: stand blue, grip orange, contact red, outlet green, slot purple';
const MAX_COLS = 6;

/** The values one state field takes in a sheet, its default first. A field with nothing to vary is its default alone. */
export function valuesOf(f) {
  const d = f.default, more = [];
  if (f.type === 'bool') more.push(!d);
  else if (f.type === 'enum') more.push(...f.values.filter(v => v !== d));
  else if (f.type === 'int' && Number.isInteger(f.min) && Number.isInteger(f.max)) more.push(f.min, f.min + Math.floor((f.max - f.min) / 2), f.max);
  return [d, ...more.filter((v, i) => v !== d && more.indexOf(v) === i)];
}

/** The number the viewer draws a whole-number state value with. */
const drawn = (f, v) => (f.type === 'int' && f.unit === 'permille' ? v / 1000 : v);

/** A field's default as a value: a timed field's default is its value at its start. */
const defaultOf = f => (f.type === 'timed' ? f.default.value : f.default);

/** The state fields a picture can show: words by reference (text), a list and a schedule change no part. */
const pictured = entry => Object.entries(entry.state ?? {}).filter(([, f]) => !['text', 'list', 'schedule'].includes(f.type));

/** The frames of an entry: its default state, then each field varied alone. The label names the field and its value. */
export function framesOf(entry) {
  const fields = pictured(entry).sort((a, b) => a[1].n - b[1].n);
  const base = Object.fromEntries(fields.map(([k, f]) => [k, defaultOf(f)]));
  const frames = [{label: fields.length ? `${fields.map(([k]) => `${k}=${base[k]}`).join(' ')} (default)` : 'no state', values: base}];
  for (const [k, f] of fields) for (const v of valuesOf(f).slice(1)) frames.push({label: `${k}=${v}`, values: {...base, [k]: v}});
  return frames.map(fr => ({label: fr.label, values: fr.values, state: Object.fromEntries(fields.map(([k, f]) => [k, drawn(f, fr.values[k])]))}));
}

const metres = v => v.map(x => x / 1000);
const LENGTH_KEYS = new Set(['at', 'size', 'r', 'r2', 'h', 'round', 'profile', 'path', 'polygon', 'p', 'pivot', 'width', 'height', 'depth']);
const ANGLE_KEYS = new Set(['roll', 'arc', 'yaw', 'pitch']);
const COUNT_KEYS = new Set(['segments']);
/** A part's stretch (scale, 1000 is as drawn) and its own glow (1000 is full), in permille, as the fraction the viewer draws with. */
const PERMILLE_KEYS = new Set(['scale', 'glow']);

/** A shape written in whole millimetres and millidegrees, as the metres and radians the viewer draws with. */
export function shapeInMetres(node, key = '') {
  if (Array.isArray(node)) return node.map(v => shapeInMetres(v, key));
  if (node !== null && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, shapeInMetres(v, k)]));
  if (typeof node !== 'number') return node;
  if (LENGTH_KEYS.has(key)) return node / 1000;
  if (ANGLE_KEYS.has(key)) return node * Math.PI / 180000;
  if (COUNT_KEYS.has(key)) return node;
  if (PERMILLE_KEYS.has(key)) return node / 1000;
  throw new Error(`looks.shape: a number under "${key}", and its unit is not known here (lengths in mm, angles in millidegrees, scale and glow in permille, counts)`);
}

/** The def the gallery studio draws: the entry's shape, with its state fields as the def's state. */
export function defOf(entry) {
  const name = `core-${entry.kind.split(':')[1]}`, shape = entry.looks?.shape;
  if (!shape?.shapes) return null;
  const state = Object.fromEntries(pictured(entry).map(([k, f]) => [k,
    f.type === 'bool' ? {type: 'bool', default: f.default}
      : f.type === 'enum' ? {type: 'enum', values: f.values, default: f.default}
        : {type: 'number', default: drawn(f, defaultOf(f))}]));
  const b = entry.geometry?.bounds_mm;
  // SA-D1a: the looks table rides in the def's make.args, where the page's one drawing function reads it
  const kit = {kind: 'gen', gen: 'kit/2', args: shapeInMetres({round: shape.round, shapes: shape.shapes})};
  const make = entry.looks?.table ? {...kit, args: {...kit.args, looks_table: entry.looks.table, looks_units: Object.fromEntries(Object.entries(entry.state ?? {}).filter(([, f]) => f.unit).map(([k, f]) => [k, f.unit]))}} : kit;
  return {schema: 'def/1', name, version: 1, description: entry.text?.[entry.card?.text] ?? entry.kind, tags: shape.tags ?? [], form: 'point',
    make, params: {}, palette: shape.palette ?? {}, state, size: {box: b ? metres(b) : [1, 1, 1]}};
}

/** The named places to mark: points by role, slots as slots. */
export function marksOf(entry) {
  const marks = [];
  for (const [name, p] of Object.entries(entry.points ?? {})) marks.push({name, role: p.role, at: metres(p.at_mm)});
  for (const [name, s] of Object.entries(entry.slots ?? {})) marks.push({name, role: 'slot', at: metres(s.at_mm)});
  return marks;
}

export function loadEntries(target, rootDir) {
  const asPath = resolve(target);
  const path = (() => { try { statSync(asPath); return asPath; } catch { return join(resolve(root, rootDir), target); } })();
  const rows = [];
  for (const file of loadDir(path)) {
    const {entry, errors} = parseEntry(readFileSync(file, 'utf8'));
    rows.push({file, entry, errors: entry ? [...errors, ...validateEntry(entry)] : errors});
  }
  return rows;
}

export function look(target, {root: rootDir = 'content/kinds', out, kind, plan = false} = {}) {
  const outDir = resolve(out ?? join(root, '.local/look', new Date().toISOString().replace(/[:.]/g, '-')));
  const results = [];
  for (const {file, entry, errors} of loadEntries(target, rootDir)) {
    if (!entry || errors.length) { results.push({file, errors: errors.map(e => `${e.path}: ${e.reason}`)}); continue; }
    if (kind && entry.kind.split(':')[1] !== kind && entry.kind !== kind) continue;
    let def; try { def = defOf(entry); } catch (e) { results.push({kind: entry.kind, file, errors: [e.message]}); continue; }
    const frames = framesOf(entry), result = {kind: entry.kind, file, frames: frames.map(f => f.label)};
    results.push(result);
    if (!def) { result.errors = ['looks.shape.shapes is missing: there is nothing to draw']; continue; }
    if (plan) continue;
    const dir = join(outDir, entry.kind.replace(':', '-'));
    mkdirSync(dir, {recursive: true});
    const defs = join(dir, 'def.json'), states = join(dir, 'states.json');
    writeFileSync(defs, JSON.stringify([def]));
    writeFileSync(states, JSON.stringify({[def.name]: {frames: frames.map(f => ({label: f.label, state: f.state})), marks: marksOf(entry), sub: Object.keys(entry.points ?? {}).join(' · ')}}));
    const cols = Math.min(MAX_COLS, frames.length), gdir = join(dir, 'gallery');
    const r = spawnSync(process.execPath, [join(root, 'tools/god-skill/scripts/gallery.mjs'), '--local', '--defs', defs, '--states', states, '--cols', String(cols),
      '--title', `${entry.kind} — ${frames.length} frame${frames.length === 1 ? '' : 's'} — ${LEGEND}`, '--out', gdir], {cwd: root, encoding: 'utf8'});
    const gj = (() => { try { return JSON.parse(readFileSync(join(gdir, 'gallery.json'), 'utf8')); } catch { return null; } })();
    result.sheet = join(dir, 'sheet.png');
    if (r.status === 0 || gj) {
      try { writeFileSync(result.sheet, readFileSync(join(gdir, 'sheet.png'))); } catch { /* reported below */ }
    }
    result.tris = gj?.tris ?? [];
    // how many of the frames came out as different pictures (a state the picture ignores gives the same frame twice)
    result.distinct = new Set((gj?.captures ?? []).map(c => createHash('sha256').update(readFileSync(join(gdir, c.file))).digest('hex'))).size;
    result.errors = [...(gj?.errors ?? [])];
    if (r.status !== 0 || !gj) result.errors.push(`the gallery run failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  }
  return {out: outDir, results};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2), flag = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const target = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--plan'));
  if (!target) { console.error('usage: node tools/entry/look.mjs <family|folder|file> [--root content/kinds] [--out <dir>] [--kind <name>] [--plan]'); process.exit(2); }
  const {results} = look(target, {root: flag('root'), out: flag('out'), kind: flag('kind'), plan: argv.includes('--plan')});
  for (const r of results) console.log(JSON.stringify(r));
  process.exitCode = results.length && results.every(r => !r.errors?.length) ? 0 : 1;
}
