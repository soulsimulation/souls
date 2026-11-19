#!/usr/bin/env node
// The look gate for things (Soul Actions SA-P4, #2863): a picture of a kind in every state it declares.
//
//   node tools/entry/look.mjs <family|folder|file> [--root content/kinds] [--out <dir>] [--kind <name>] [--plan]
//
// Writes one sheet per kind, <out>/<namespace>-<name>/sheet.png: the kind drawn once in its default state, then once per
// other value of each state field, one field varied at a time, the rest left at their defaults, with the kind's points
// (and slots) marked over it. A kind with no state fields is one frame. It runs headless (the library gallery's studio page
// in headless Chrome, tools/god-skill/scripts/gallery.mjs) and prints one JSON line per kind: its sheet, frames and errors.
// A kind the gallery captured no picture of fails, with the cause: a tag the gallery skips, or a gallery run that stopped
// before it captured anything. With --plan it prints the frames it would draw and renders nothing. Sheets are attached to
// a pull request, never committed.
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
import {mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDir, parseEntry, validateEntry} from './format.mjs';
import {loadMoves} from './move.mjs';
import {effectorAt, handAt, timesOf} from './pose.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARK_ROLES = ['stand', 'grip', 'contact', 'outlet', 'slot'];
const LEGEND = 'points: stand blue, grip orange, contact red, outlet green, slot purple';
const MAX_COLS = 6;
// The tags the library gallery leaves out of a sheet (tools/god-skill/scripts/gallery.mjs, its `defs` filter): a kind
// shaped with one of them is never drawn.
const GALLERY_SKIPS = ['body', 'marker', 'landform'];

/** The values one state field takes in a sheet, its default first. A field with nothing to vary is its default alone. */
export function valuesOf(f) {
  // a timed value is drawn at a value it holds, from its default to its bounds (the sheet stops the clock)
  const d = f.type === 'timed' ? f.default.value : f.default, more = [];
  if (f.type === 'bool') more.push(!d);
  else if (f.type === 'enum') more.push(...f.values.filter(v => v !== d));
  else if ((f.type === 'int' || f.type === 'timed') && Number.isInteger(f.min) && Number.isInteger(f.max)) more.push(f.min, f.min + Math.floor((f.max - f.min) / 2), f.max);
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

/** Why a gallery run gave a kind no picture, or null when it captured one. A sheet with no frame on it is a failure,
 *  never a pass: the def carries a tag the gallery leaves out, or the gallery stopped before it captured anything. */
export function noCaptures(def, {status, gallery, tail = ''}) {
  if (gallery?.captures?.length) return null;
  const tag = GALLERY_SKIPS.find(t => def.tags?.includes(t));
  if (tag) return `nothing drawn: the gallery skips a def tagged "${tag}" (looks.shape.tags)`;
  if (!gallery || status !== 0) return `nothing drawn: the gallery exited (exit ${status}) before capturing anything${tail ? `: ${tail}` : ''}`;
  return `nothing drawn: the gallery left the def out of its sheet (make ${JSON.stringify(def.make?.kind ?? def.make?.gen ?? null)} is one it does not draw)`;
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

export function look(target, {root: rootDir = 'content/kinds', out, kind, plan = false, gallery = join(root, 'tools/god-skill/scripts/gallery.mjs')} = {}) {
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
    rmSync(gdir, {recursive: true, force: true}); // an old run's gallery.json must not stand in for this one
    const r = spawnSync(process.execPath, [gallery, '--local', '--defs', defs, '--states', states, '--cols', String(cols),
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
    const tail = (r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-3).join(' | ');
    const none = noCaptures(def, {status: r.status, gallery: gj, tail});
    if (none) result.errors.push(none);
    else if (r.status !== 0) result.errors.push(`the gallery run failed (exit ${r.status}): ${tail}`);
  }
  return {out: outDir, results};
}

// ---- The look gate for bodies (Soul Actions SA-P5, #2934): a humanoid body at chosen moments of a hand action ----
//
//   node tools/entry/look.mjs <file> --body <form> [--on <mm>] [--shift <point>=<dx>,<dy>,<dz>] [--out <dir>] [--plan]
//
// One sheet per form whose steps include a move (a hand action): five moments (start, reaching, contact, holding or
// returning, end) from two views, the body drawn as a kit/2 figure of the humanoid's proportions with the thing. The
// hand is where SA-D4's `handAt` puts it for the form's move record; the arm is two bones from the shoulder, and a hand
// the arm cannot reach stops at the arm's length (the sheet says by how much). The last moment shows the state after
// the form's `set` effects; the first starts from the defaults, changed only as far as the form's state needs ask.
// A form that needs the thing held (`held_by_actor`) draws it in the hand by its grip point; a pour goes to the rim of
// a plain vessel set in front of the body, a consume to the body's mouth. `--on` is the height in mm of the surface the
// thing stands on (a counter is drawn under it); `--shift` moves one point of the entry, for a deliberate mistake.
// Printed on every frame: the distance in whole millimetres from the move's effector (`effectorAt`: the record's hand,
// not the drawn one) to the target's box, which is the thing's `geometry.bounds_mm`, the vessel or the mouth. The
// record and that number are whole-number arithmetic, the same on any runner; only the drawing uses fractions. The
// sheet is judged against tools/entry/RUBRIC.md.

/** The humanoid body, in whole millimetres: feet at the origin, facing +z, its right side at -x. */
export const BODY = Object.freeze({shoulder: [-190, 1430, 0], upper_mm: 310, lower_mm: 340, mouth: [0, 1590, 105], rest: [-215, 820, 90], rest_held: [-240, 800, 140]});
/** How far a held thing tips about the body's side-to-side axis while it pours or is drunk from, as (sin, cos) permille: 40 and 35 degrees. */
const TIP = {pour: [643, 766], consume: [-574, 819]};
const VESSEL = {at: [-200, 0, 700], r: 45, h: 95, over_mm: 25};
const isqrt = n => { let r = Math.floor(Math.sqrt(n)); while (r * r > n) r--; while ((r + 1) * (r + 1) <= n) r++; return r; };
const rdiv = (n, d) => (n < 0 ? -Math.floor((-n * 2 + d) / (2 * d)) : Math.floor((n * 2 + d) / (2 * d)));
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = v => isqrt(v.reduce((s, x) => s + x * x, 0));
/** A body-frame vector turned by (sin, cos) in permille, so +z goes to (sin, 0, cos); whole millimetres. */
const turn = ([x, y, z], [s, c]) => [rdiv(x * c + z * s, 1000), y, rdiv(-x * s + z * c, 1000)];
/** A horizontal direction (x, z) as (sin, cos) in permille. */
const heading = ([x, z]) => { const l = isqrt(x * x + z * z); return l ? [rdiv(x * 1000, l), rdiv(z * 1000, l)] : [0, 1000]; };
const angle = ([s, c]) => Math.atan2(s, c);

/** Whole-millimetre distance from a point to a box given by its low and high corners. */
export function distanceToBox(p, lo, hi) {
  return isqrt(p.reduce((sum, v, i) => { const d = v < lo[i] ? lo[i] - v : v > hi[i] ? v - hi[i] : 0; return sum + d * d; }, 0));
}

/** The state a form starts from: the defaults, changed only as far as its state needs ask. */
export function stateFor(entry, form) {
  const st = Object.fromEntries(Object.entries(entry.state ?? {}).map(([k, f]) => [k, defaultOf(f)]));
  for (const n of form.needs ?? []) {
    const f = entry.state?.[n.field];
    if (n.need !== 'state' || !f) continue;
    if ('is' in n) st[n.field] = n.is;
    else if ('not' in n && st[n.field] === n.not) st[n.field] = f.type === 'bool' ? !n.not : f.values?.find(v => v !== n.not);
    else if ('at_least' in n && !(st[n.field] >= n.at_least)) st[n.field] = f.max ?? n.at_least;
    else if ('at_most' in n && !(st[n.field] <= n.at_most)) st[n.field] = f.min ?? n.at_most;
  }
  return st;
}

/** The state after a form's `set` effects (`to`, or `by` within the field's bounds). */
export function afterEffects(entry, form, st) {
  const out = {...st};
  for (const e of form.effects ?? []) {
    const f = entry.state?.[e.field];
    if (e.change !== 'set' || !f) continue;
    if ('to' in e) out[e.field] = e.to;
    else if (Number.isInteger(e.by)) out[e.field] = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, out[e.field] + e.by));
  }
  return out;
}

/** The five moments of a move: start, halfway to contact, contact, halfway through the hold (or the return), end. */
export function momentsOf(move) {
  const {contact_us: c, slide_end_us: h, end_us: e} = timesOf(move);
  return [{t_us: 0, name: 'start'}, {t_us: Math.floor(c / 2), name: 'reaching'}, {t_us: c, name: 'contact'},
    h > c ? {t_us: Math.floor((c + h) / 2), name: 'holding'} : {t_us: Math.floor((c + e) / 2), name: 'returning'}, {t_us: e, name: 'end'}];
}

/** Where everything of a form's sheet is, in whole millimetres: the body, the move record, the target's box. */
export function bodyScene(entry, formName, moves, {on_mm = 0, shift} = {}) {
  const form = entry.forms?.[formName];
  if (!form) throw new Error(`${entry.kind} has no form "${formName}" (forms: ${Object.keys(entry.forms ?? {}).join(', ')})`);
  const step = (form.steps ?? []).find(s => s.step === 'move');
  if (!step) throw new Error(`form "${formName}" has no move step: it is not a hand action`);
  const move = moves[step.move];
  if (!move) throw new Error(`move "${step.move}" is not in content/moves`);
  const points = structuredClone(entry.points ?? {});
  if (shift) {
    if (!points[shift.point]) throw new Error(`--shift: ${entry.kind} has no point "${shift.point}"`);
    points[shift.point].at_mm = add(points[shift.point].at_mm, shift.by_mm);
  }
  const at = points[step.at]?.at_mm;
  if (!at) throw new Error(`the step's point "${step.at}" is not a point of ${entry.kind}`);
  const held = (form.needs ?? []).some(n => n.need === 'held_by_actor');
  const b = entry.geometry?.bounds_mm ?? [0, 0, 0];
  if (!held) {
    const flat = p => (p[0] - at[0]) ** 2 + (p[2] - at[2]) ** 2;
    const stand = Object.values(points).filter(p => p.role === 'stand').sort((p, q) => flat(p.at_mm) - flat(q.at_mm))[0]?.at_mm;
    if (!stand) throw new Error(`${entry.kind} has no stand point to put the body at`);
    const feet = [stand[0], 0, stand[2]], contact = add(at, [0, on_mm, 0]), face = heading([contact[0] - feet[0], contact[2] - feet[2]]);
    return {form, step, move, held, feet, face, points, thingAt: [0, on_mm, 0],
      record: {start_us: 0, from_mm: add(feet, turn(BODY.rest, face)), contact_mm: contact},
      target: {name: `${entry.kind} (its box)`, lo: [-Math.floor(b[0] / 2), on_mm, -Math.floor(b[2] / 2)], hi: [Math.ceil(b[0] / 2), on_mm + b[1], Math.ceil(b[2] / 2)]},
      support: on_mm > 0 ? {at: [0, on_mm, 0], size: [b[0] + 160, on_mm, b[2] + 160]} : null};
  }
  const grip = (points.grip ?? Object.values(points).find(p => p.role === 'grip'))?.at_mm;
  if (!grip) throw new Error(`${entry.kind} is held but has no grip point`);
  const feet = [0, 0, 0], face = [0, 1000], eats = move.phases.consume_us !== undefined;
  const v = {...VESSEL, at: [VESSEL.at[0], on_mm, VESSEL.at[2]]};
  const contact = eats ? BODY.mouth : [v.at[0], on_mm + v.h + v.over_mm, v.at[2]];
  // the held thing turns so its grip-to-effector points where the effector goes: forward to a vessel, back to the mouth
  const g = heading([at[0] - grip[0], at[2] - grip[2]]), w = eats ? [0, -1000] : [0, 1000];
  const rot = [rdiv(w[0] * g[1] - w[1] * g[0], 1000), rdiv(w[0] * g[0] + w[1] * g[1], 1000)], tip = eats ? TIP.consume : TIP.pour;
  // the pose it is held in at contact: turned, then tipped so the effector end goes down (Rx: y' = y cos - z sin, z' = y sin + z cos)
  const [ex, ey, ez] = turn(sub(at, grip), rot), effector_mm = [ex, rdiv(ey * tip[1] - ez * tip[0], 1000), rdiv(ey * tip[0] + ez * tip[1], 1000)];
  return {form, step, move, held, feet, face, points, grip, rot, tip, vessel: eats ? null : v,
    record: {start_us: 0, from_mm: turn(BODY.rest_held, face), contact_mm: contact, effector_mm, count: 1},
    target: eats ? {name: 'the mouth', lo: BODY.mouth, hi: BODY.mouth} : {name: 'the vessel', lo: [v.at[0] - v.r, on_mm, v.at[2] - v.r], hi: [v.at[0] + v.r, on_mm + v.h, v.at[2] + v.r]},
    support: on_mm > 0 && !eats ? {at: [v.at[0], on_mm, v.at[2] + 40], size: [520, on_mm, 360]} : null};
}

/** The hand the body can draw at a time: the record's hand, stopped at the arm's length from the shoulder. */
function reachOf(sc, t_us) {
  const hand = handAt(sc.move, sc.record, t_us), shoulder = add(sc.feet, turn(BODY.shoulder, sc.face)), arm = BODY.upper_mm + BODY.lower_mm;
  const d = sub(hand, shoulder), l = len(d);
  return {hand: l > arm ? add(shoulder, d.map(x => rdiv(x * arm, l))) : hand, beyond_mm: Math.max(0, l - arm)};
}

/** The number printed on a frame: effector to the target's box, whole millimetres, from the record alone. */
export const distanceAt = (sc, t_us) => distanceToBox(effectorAt(sc.move, sc.record, t_us), sc.target.lo, sc.target.hi);

// Drawing only (fractions allowed from here): kit/2 shapes in metres, turned about y by `a` radians and moved by `at`.
const M = v => v.map(x => x / 1000);
const rotY = ([x, y, z], a) => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
// a role's `pivot` is a place in the def's frame, so it moves with its shape
const placed = (shape, a, at) => ({...shape, at: add(rotY(shape.at ?? [0, 0, 0], a), at), yaw: (shape.yaw ?? 0) + a, ...(shape.pivot ? {pivot: add(rotY(shape.pivot, a), at)} : {})});
/** Rotation matrices in three's YXZ order (yaw about y, then pitch about x, then roll about z), and back. */
const matYXZ = (y, p, r) => { const [cy, sy, cp, sp, cr, sr] = [Math.cos(y), Math.sin(y), Math.cos(p), Math.sin(p), Math.cos(r), Math.sin(r)];
  return [[cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp], [cp * sr, cp * cr, -sp], [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp]]; };
const mul = (A, B) => A.map(row => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
const apply = (A, v) => A.map(row => row.reduce((s, x, k) => s + x * v[k], 0));
/** A shape of a held thing: its grip at the hand, turned and tipped by `Rw` about the grip. */
const held = (shape, Rw, G, hand) => {
  const m = mul(Rw, matYXZ(shape.yaw ?? 0, shape.pitch ?? 0, shape.roll ?? 0));
  return {...shape, at: add(hand, apply(Rw, sub(shape.at ?? [0, 0, 0], G))), ...(shape.pivot ? {pivot: add(hand, apply(Rw, sub(shape.pivot, G)))} : {}), yaw: Math.atan2(m[0][2], m[2][2]), pitch: Math.asin(-Math.max(-1, Math.min(1, m[1][2]))), roll: Math.atan2(m[1][0], m[1][1])};
};
const BODY_PALETTE = {p5_skin: '#d8b08a', p5_shirt: '#4f7ca8', p5_legs: '#3b3d48', p5_shoe: '#2a2622', p5_counter: '#b59b78', p5_vessel: '#f4f1ea'};

/** The elbow of a two-bone arm from shoulder S to hand H (mm), bent toward `pull`. */
function elbowOf(S, H, a, b, pull) {
  const d = sub(H, S), L = Math.hypot(...d) || 1, u = d.map(x => x / L), dd = Math.min(Math.max(L, Math.abs(a - b) + 1), a + b - 1);
  const x = (a * a - b * b + dd * dd) / (2 * dd), r = Math.sqrt(Math.max(0, a * a - x * x));
  const k = pull.reduce((s, p, i) => s + p * u[i], 0), pole = pull.map((p, i) => p - k * u[i]), pl = Math.hypot(...pole) || 1;
  return S.map((v, i) => v + u[i] * x + (pole[i] / pl) * r);
}

/** The body's kit/2 shapes (metres) with its right hand at `hand` (mm). */
function bodyShapes(sc, hand) {
  const a = angle(sc.face), P = local => add(sc.feet, turn(local, sc.face));
  const box = (at, size, tint, round = 40) => ({kind: 'box', at: M(P(at)), size: M(size), round: round / 1000, tint, yaw: a});
  const ball = (at, r, tint) => ({kind: 'sphere', at: M(at), r: r / 1000, segments: 12, tint});
  const tube = (from, to, r, tint) => ({kind: 'sweep', at: [0, 0, 0], path: [M(from), M(to)], r: r / 1000, segments: 8, tint});
  const out = [box([0, 1180, 0], [380, 520, 220], 'p5_shirt', 70), box([0, 930, 0], [350, 180, 210], 'p5_legs', 50),
    {kind: 'cyl', at: M(P([0, 1490, 0])), r: 0.05, h: 0.09, segments: 12, tint: 'p5_skin'}, ball(P([0, 1650, 10]), 105, 'p5_skin'), ball(P([0, 1650, 112]), 18, 'p5_skin'),
    ball(P([-190, 1420, 0]), 60, 'p5_shirt'), ball(P([190, 1420, 0]), 60, 'p5_shirt')];
  for (const x of [-100, 100]) {
    const hip = P([x, 920, 0]), knee = P([x + x / 20, 500, 20]), ankle = P([x + x / 20, 95, 0]);
    out.push(tube(hip, knee, 68, 'p5_legs'), tube(knee, ankle, 58, 'p5_legs'), ball(knee, 60, 'p5_legs'), box([x + x / 20, 40, 55], [105, 80, 250], 'p5_shoe', 30));
  }
  // the left arm hangs; the right arm reaches, two bones from the shoulder, its elbow pulled down, out and back
  const lS = P([190, 1430, 0]), lE = P([220, 1130, -10]), lH = P([230, 830, 40]);
  out.push(tube(lS, lE, 48, 'p5_shirt'), tube(lE, lH, 40, 'p5_skin'), ball(lH, 46, 'p5_skin'));
  const S = P(BODY.shoulder), pull = add(add([0, -1000, 0], turn([-600, 0, 0], sc.face)), turn([0, 0, -300], sc.face));
  const E = elbowOf(S, hand, BODY.upper_mm, BODY.lower_mm, pull);
  out.push(tube(S, E, 48, 'p5_shirt'), ball(E, 45, 'p5_shirt'), tube(E, hand, 40, 'p5_skin'), ball(hand, 46, 'p5_skin'));
  return out;
}

/** The sheet's defs and frames: per moment and view, one def of the thing, its support, the body and the marks. */
export function bodyFrames(entry, sc) {
  const thingShapes = shapeInMetres(entry.looks?.shape?.shapes ?? []);
  if (!thingShapes.length) throw new Error('looks.shape.shapes is missing: there is nothing to draw');
  const base = defOf({...entry, points: sc.points});
  const start = stateFor(entry, sc.form), end = afterEffects(entry, sc.form, start);
  const shown = st => Object.fromEntries(pictured(entry).map(([k, f]) => [k, drawn(f, st[k])]));
  const changed = Object.keys(end).filter(k => end[k] !== start[k]).map(k => `${k}=${end[k]}`).join(' ');
  const defs = [], states = {};
  const views = [{name: 'a', yaw: (-60 * Math.PI) / 180}, {name: 'b', yaw: (60 * Math.PI) / 180}];
  momentsOf(sc.move).forEach((m, i) => {
    const r = reachOf(sc, m.t_us), last = i === 4, dist = distanceAt(sc, m.t_us);
    // a held thing hangs from the drawn hand by its grip, tipped in full at contact and while holding, half on the way
    const Rw = sc.held ? mul(matYXZ(0, Math.atan2(sc.tip[0], sc.tip[1]) * [0, 0.5, 1, 1, 0][i], 0), matYXZ(angle(sc.rot), 0, 0)) : null;
    const G = sc.held ? M(sc.grip) : null, hand = M(r.hand);
    const effector = sc.held ? add(hand, apply(Rw, sub(M(sc.points[sc.step.at].at_mm), G))) : hand;
    const world = [...thingShapes.map(s => (sc.held ? held(s, Rw, G, hand) : placed(s, 0, M(sc.thingAt)))),
      ...(sc.support ? [{kind: 'box', at: M([sc.support.at[0], sc.support.at[1] / 2, sc.support.at[2]]), size: M(sc.support.size), round: 0.01, tint: 'p5_counter'}] : []),
      ...(sc.vessel ? [{kind: 'cyl', at: M([sc.vessel.at[0], sc.vessel.at[1] + sc.vessel.h / 2, sc.vessel.at[2]]), r: sc.vessel.r / 1000, h: sc.vessel.h / 1000, segments: 16, tint: 'p5_vessel'}] : []),
      ...bodyShapes(sc, r.hand)];
    for (const v of views) {
      const turnTo = v.yaw - angle(sc.face) - 0.5; // the studio turns every def by 0.5 rad; the body then faces v.yaw
      const name = `core-p5-${v.name}${i + 1}`;
      defs.push({...base, name, tags: (base.tags ?? []).filter(t => !['body', 'marker', 'landform', 'creature'].includes(t)),
        make: {...base.make, args: {...base.make.args, shapes: world.map(s => placed(s, turnTo, [0, 0, 0]))}}, palette: {...base.palette, ...BODY_PALETTE}, size: {box: [2, 2, 2]}});
      states[name] = {frames: [{label: `${i + 1} ${m.name} · ${Math.floor(m.t_us / 1000)} ms · hand→target ${dist} mm${r.beyond_mm ? ` · arm short by ${r.beyond_mm} mm` : ''}${last && changed ? ` · ${changed}` : ''}`,
        state: shown(last ? end : start)}],
      marks: [{name: 'target', role: 'contact', at: rotY(M(sc.record.contact_mm), turnTo)}, {name: 'effector', role: 'grip', at: rotY(effector, turnTo)}],
      sub: `view ${v.name.toUpperCase()}`};
    }
  });
  return {defs, states, start, end};
}

/** Body sheets: for each entry with the form, one sheet of five moments from two views (see the note above). */
export function lookBody(target, {root: rootDir = 'content/kinds', out, kind, form: formName, on_mm = 0, shift, plan = false} = {}) {
  const outDir = resolve(out ?? join(root, '.local/look', new Date().toISOString().replace(/[:.]/g, '-')));
  const moves = Object.fromEntries(loadMoves(join(root, 'content/moves')).filter(r => r.move).map(r => [r.move.move, r.move]));
  const results = [];
  for (const {file, entry, errors} of loadEntries(target, rootDir)) {
    if (!entry || errors.length) { results.push({file, errors: errors.map(e => `${e.path}: ${e.reason}`)}); continue; }
    if ((kind && entry.kind.split(':')[1] !== kind && entry.kind !== kind) || !entry.forms?.[formName]) continue;
    const result = {kind: entry.kind, form: formName, file};
    results.push(result);
    let sc, built;
    try { sc = bodyScene(entry, formName, moves, {on_mm, shift}); built = bodyFrames(entry, sc); } catch (e) { result.errors = [e.message]; continue; }
    const contact = momentsOf(sc.move)[2].t_us;
    Object.assign(result, {move: sc.step.move, held: sc.held, target: sc.target.name, record: sc.record, contact_distance_mm: distanceAt(sc, contact),
      arm_short_mm: reachOf(sc, contact).beyond_mm, moments: momentsOf(sc.move), ...(shift ? {shifted: shift} : {}), errors: []});
    if (plan) continue;
    const dir = join(outDir, `${entry.kind.replace(':', '-')}-${formName}${shift ? `-shifted-${shift.point}` : ''}`);
    mkdirSync(dir, {recursive: true});
    const defs = join(dir, 'def.json'), states = join(dir, 'states.json'), gdir = join(dir, 'gallery');
    writeFileSync(defs, JSON.stringify(built.defs));
    writeFileSync(states, JSON.stringify(built.states));
    const title = `${entry.kind} · ${formName} (${sc.step.move}${sc.held ? ', held' : ''}) — 5 moments × 2 views — at contact: hand→target ${result.contact_distance_mm} mm` +
      `${result.arm_short_mm ? `, arm short by ${result.arm_short_mm} mm` : ''}${shift ? ` — point ${shift.point} moved by [${shift.by_mm}] mm` : ''} — red: the form's point, orange: the effector`;
    const r = spawnSync(process.execPath, [join(root, 'tools/god-skill/scripts/gallery.mjs'), '--local', '--defs', defs, '--states', states, '--cols', '5', '--cw', '560', '--ch', '470',
      '--title', title, '--out', gdir], {cwd: root, encoding: 'utf8'});
    const gj = (() => { try { return JSON.parse(readFileSync(join(gdir, 'gallery.json'), 'utf8')); } catch { return null; } })();
    result.sheet = join(dir, 'sheet.png');
    try { writeFileSync(result.sheet, readFileSync(join(gdir, 'sheet.png'))); } catch { /* reported below */ }
    result.errors = [...(gj?.errors ?? [])];
    if (r.status !== 0 || !gj) result.errors.push(`the gallery run failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  }
  return {out: outDir, results};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2), flag = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const target = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--plan'));
  if (!target) { console.error('usage: node tools/entry/look.mjs <family|folder|file> [--root content/kinds] [--out <dir>] [--kind <name>] [--plan] [--body <form> [--on <mm>] [--shift <point>=<dx>,<dy>,<dz>]]'); process.exit(2); }
  const shiftArg = flag('shift'), shift = shiftArg ? {point: shiftArg.split('=')[0], by_mm: (shiftArg.split('=')[1] ?? '').split(',').map(Number)} : undefined;
  if (shift && !(shift.by_mm.length === 3 && shift.by_mm.every(Number.isSafeInteger))) { console.error('--shift <point>=<dx>,<dy>,<dz> in whole millimetres'); process.exit(2); }
  const opts = {root: flag('root'), out: flag('out'), kind: flag('kind'), plan: argv.includes('--plan')};
  const {results} = flag('body') ? lookBody(target, {...opts, form: flag('body'), on_mm: Number(flag('on') ?? 0), shift}) : look(target, opts);
  for (const r of results) console.log(JSON.stringify(r));
  process.exitCode = results.length && results.every(r => !r.errors?.length) ? 0 : 1;
}
