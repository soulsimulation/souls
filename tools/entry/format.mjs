#!/usr/bin/env node
// The entry format (Soul Actions SA-F1, #2842): one kind as data, written for Engine v2 and validated here.
// Page: docs/soul-actions/entry-format.md. Nothing in the running server reads this yet.
//
//   node tools/entry/format.mjs content/kinds            validate every entry under a folder (or named files)
//
// Prints one JSON line per file: its kind, its provisional reference `namespace:name@prov-1220<sha-256>`, and any
// errors, each naming the path of the field at fault. Exits 1 if any entry is refused.
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const FORMAT = 'souls-entry/1';

/** Every section has a number, so a section can be added without moving the others. Sections 1 to 19 are the kind's
 *  meaning and are covered by its hash; sections 20 and up sit beside it under their own hash (contract T3, #2640). */
export const SECTIONS = Object.freeze({format: 0, kind: 1, owner: 2, state: 3, links: 4, points: 5, slots: 6, geometry: 7, forms: 8, closed: 9, children: 10,
  looks: 20, text: 21, card: 22, howtos: 23});
export const BESIDE_FROM = 20;
/** Sections a later task defines. Until it lands, an entry that carries one is refused with that task's name. */
export const RESERVED = Object.freeze({reactions: 'SA-F15', motion: 'SA-F10', loose: 'SA-F10', stock: 'SA-F12', areas: 'SA-D6', schedule: 'SA-F16', hatch: 'SA-F9'});

/** What a kind is the kind of: a thing, a body's family, or a kind of ground or place (Engine v2 E21, #2791). */
export const OWNERS = Object.freeze(['thing', 'family', 'place']);
export const FIELD_TYPES = Object.freeze(['bool', 'enum', 'int', 'duration', 'text', 'list']);
/** A list's record holds small values only: no text and no id, so a Soul cannot be inside one (SA-F6a, #2846). */
export const RECORD_TYPES = Object.freeze(['bool', 'enum', 'int', 'duration']);
/** The largest bound a list may declare: it is set whole on every change, so it stays in tens (Engine v2 F11, #2774). */
export const LIST_MOST = 100;
export const RECORD_FIELDS_MOST = 8;
/** Whole-number units for an `int` field; a rate is `<unit>/s`. Durations are their own type, in microseconds. */
export const UNITS = Object.freeze(['count', 'mm', 'g', 'mC', 'permille']);
/** The audience rules a field may declare: the one closed list (SA-F8, #2849). A rule names a link type, never a Soul;
 *  each resolves to a set of principals when a value is written (contract T8, #2662). `everyone`; `owner` (the
 *  thing's owner); `linked` (whoever is linked to this thing by the named link of this kind: its members, the Soul
 *  whose turn it is); `creator` (the world's creator). Written `{"rule": "everyone"}` or `{"rule": "linked", "link": "<name>"}`. */
export const AUDIENCE_RULES = Object.freeze(['everyone', 'owner', 'linked', 'creator']);
/** What may be at a link's `from` end: a Soul, a body, a thing, or a kind named `namespace:name`. The other end is the
 *  kind that declares the link; links are found from either end (contract T2, #2641). */
export const LINK_ENDS = Object.freeze(['soul', 'body', 'thing']);
export const POINT_ROLES = Object.freeze(['stand', 'grip', 'contact', 'outlet']);
export const SLOT_ADMITS = Object.freeze(['body', 'thing']);
export const POSTURES = Object.freeze(['sit', 'lie']);
export const WHO = Object.freeze(['anyone', 'holder', 'world']);
export const STARTS = Object.freeze(['act', 'timer']);
export const ARG_TYPES = Object.freeze(['slot', 'part', 'thing', 'text', 'duration', 'count']);
/** A described target: one closed list with Engine v2 E2 (#2709): a candidate set, an anchor, an order and a rank. */
export const SELECT = Object.freeze({of: ['things', 'free_slots'], in: ['this', 'here', 'parent'], anchor: ['me', 'this'], order: ['nearest', 'furthest']});
/** The closed lists. Each grows only with the task that first needs a new member. */
export const NEEDS = Object.freeze(['state', 'slot_free', 'within_reach', 'held_by_actor', 'linked', 'unlinked']);
export const STEPS = Object.freeze(['walk_to', 'sit', 'rise', 'move', 'take', 'put', 'use_held', 'wait']);
export const CHANGES = Object.freeze(['set', 'reparent', 'link', 'unlink', 'create', 'remove', 'timer']);
export const SUBJECTS = Object.freeze(['actor', 'this']);

const IDENT = /^[a-z][a-z0-9_]*$/;
const KIND = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*$/;
/** Today's Soul ids (`s_ana`, `sim_…`) and any UUID: a Soul is never named inside a field (a relation is a link). */
const SOUL_ID = /^(?:s|sim|soul)_[a-z0-9]|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_TYPES = new Set(['soul', 'body', 'id', 'node', 'ref', 'thing']);
/** `ticks`, `duration_ticks`, `tick_rate`: a word, not a substring (a ticket or a stick is fine). */
const TICK = /(?:^|[_\W])[Tt]icks?(?:$|[_\W])|[a-z]Ticks?\b/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = v => Number.isSafeInteger(v);

/** Parse an entry's text. JSON.parse would turn `1.0` into 1, so the source of every number is read too. */
export function parseEntry(text) {
  const errors = [];
  let entry;
  try {
    entry = JSON.parse(text, function (key, value, context) {
      if (typeof value === 'number' && context?.source !== undefined && /[.eE]/.test(context.source)) errors.push({path: key, reason: `a floating-point number (${context.source}); write a whole number in stated units`});
      return value;
    });
  } catch (e) { return {entry: undefined, errors: [{path: '', reason: `not JSON: ${e.message}`}]}; }
  return {entry, errors};
}

/** Validate one entry. Returns a list of `{path, reason}`; an empty list means it is accepted. */
export function validateEntry(entry) {
  const errors = [];
  const err = (path, reason) => errors.push({path, reason});
  if (!isObj(entry)) return [{path: '', reason: 'an entry is an object'}];
  scan(entry, '', err);
  for (const key of Object.keys(entry)) {
    if (key in RESERVED) err(key, `section "${key}" is not defined yet; ${RESERVED[key]} adds it`);
    else if (key === 'extends') err(key, 'a published kind is written out in full; it extends nothing');
    else if (!(key in SECTIONS)) err(key, `unknown section "${key}"`);
  }
  if (entry.format !== FORMAT) err('format', `must be "${FORMAT}"`);
  if (typeof entry.kind !== 'string' || !KIND.test(entry.kind)) err('kind', 'must be "namespace:name" (the hash is computed, never written in the file)');
  if (!OWNERS.includes(entry.owner)) err('owner', `must be one of ${OWNERS.join(', ')}`);

  const state = section(entry, 'state', err), links = section(entry, 'links', err), points = section(entry, 'points', err);
  const slots = section(entry, 'slots', err), forms = section(entry, 'forms', err), text = section(entry, 'text', err);
  numbered(state, 'state', err);
  numbered(links, 'links', err);
  const closedNames = isObj(entry.closed) && Array.isArray(entry.closed.fields) ? entry.closed.fields : [];
  for (const [name, f] of Object.entries(state)) field(f, `state.${name}`, links, err, closedNames.includes(name));
  if (entry.closed !== undefined) closed(entry.closed, state, links, err);
  children(section(entry, 'children', err), err);
  for (const [name, l] of Object.entries(links)) {
    const p = `links.${name}`;
    if (!isObj(l)) { err(p, 'a link type is an object'); continue; }
    only(l, ['n', 'from', 'most', 'most_per', 'audience'], p, err);
    if (!(LINK_ENDS.includes(l.from) || (typeof l.from === 'string' && KIND.test(l.from)))) err(`${p}.from`, `must be one of ${LINK_ENDS.join(', ')}, or a kind "namespace:name"`);
    if (l.most !== undefined && !(isInt(l.most) && l.most > 0)) err(`${p}.most`, 'how many may be linked at the from end to one of these, a whole number above zero');
    if (l.most_per !== undefined && !(isInt(l.most_per) && l.most_per > 0)) err(`${p}.most_per`, 'how many of these one from end may be linked to, a whole number above zero');
    audience(l, p, links, err);
  }
  for (const [name, pt] of Object.entries(points)) {
    const p = `points.${name}`;
    if (!isObj(pt)) { err(p, 'a point is an object'); continue; }
    only(pt, ['role', 'at_mm', 'yaw_mdeg'], p, err);
    if (!POINT_ROLES.includes(pt.role)) err(`${p}.role`, `must be one of ${POINT_ROLES.join(', ')}`);
    vec(pt.at_mm, `${p}.at_mm`, err);
    if (pt.yaw_mdeg !== undefined && !isInt(pt.yaw_mdeg)) err(`${p}.yaw_mdeg`, 'whole millidegrees');
  }
  for (const [name, s] of Object.entries(slots)) {
    const p = `slots.${name}`;
    if (name in points) err(p, `"${name}" is already a point; a part's name is used once`);
    if (!isObj(s)) { err(p, 'a slot is an object'); continue; }
    only(s, ['admits', 'posture', 'most', 'at_mm', 'stand', 'fits_mm'], p, err);
    if (!SLOT_ADMITS.includes(s.admits)) err(`${p}.admits`, `must be one of ${SLOT_ADMITS.join(', ')}`);
    if (s.posture !== undefined && (s.admits !== 'body' || !POSTURES.includes(s.posture))) err(`${p}.posture`, `a body's slot only, one of ${POSTURES.join(', ')}`);
    if (!(isInt(s.most) && s.most > 0)) err(`${p}.most`, 'how many it admits, a whole number above zero');
    vec(s.at_mm, `${p}.at_mm`, err);
    if (s.fits_mm !== undefined) vec(s.fits_mm, `${p}.fits_mm`, err, true);
    if (s.stand !== undefined && points[s.stand]?.role !== 'stand') err(`${p}.stand`, 'names a point whose role is stand');
  }
  if (entry.geometry !== undefined) {
    if (!isObj(entry.geometry)) err('geometry', 'an object');
    else { only(entry.geometry, ['bounds_mm'], 'geometry', err); vec(entry.geometry.bounds_mm, 'geometry.bounds_mm', err, true); }
  }

  const ctx = {state, links, points, slots, forms};
  for (const [name, f] of Object.entries(forms)) {
    if (!IDENT.test(name)) err(`forms.${name}`, 'a form name is lower_snake_case');
    form(f, `forms.${name}`, ctx, err);
  }
  for (const [key, v] of Object.entries(text)) if (typeof v !== 'string' || !IDENT.test(key)) err(`text.${key}`, 'text is a table of name to words');
  if (entry.looks !== undefined && !isObj(entry.looks)) err('looks', 'an object (its table is SA-D1a\'s)');
  if (entry.card !== undefined) {
    if (!isObj(entry.card) || !(entry.card.text in text)) err('card.text', 'names an entry of the text table');
    else only(entry.card, ['text'], 'card', err);
  }
  for (const [name, h] of Object.entries(section(entry, 'howtos', err))) {
    const p = `howtos.${name}`;
    if (!isObj(h)) { err(p, 'a how-to is an object'); continue; }
    only(h, ['text', 'steps'], p, err);
    if (!(h.text in text)) err(`${p}.text`, 'names an entry of the text table');
    if (!Array.isArray(h.steps) || h.steps.length === 0) err(`${p}.steps`, 'a list of forms');
    else h.steps.forEach((s, i) => { if (!isObj(s) || !(s.form in forms)) err(`${p}.steps.${i}.form`, 'names a form of this kind'); });
  }
  return errors;
}

// Rules that hold anywhere in an entry: no floats, nothing in ticks, words by reference, no Soul named in a value.
function scan(v, path, err) {
  if (typeof v === 'number' && !isInt(v)) err(path, `a floating-point number (${v}); write a whole number in stated units`);
  else if (typeof v === 'string' && !path.startsWith('text.')) {
    if (TICK.test(v)) err(path, 'nothing is counted in ticks; durations are microseconds, rates per second');
    if (SOUL_ID.test(v)) err(path, 'names a Soul inside a field; a relation is a link');
    if (/\s/.test(v)) err(path, 'human words go in the text table and are named by reference');
  } else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}.${i}`, err));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) {
    const p = path ? `${path}.${k}` : k;
    if (TICK.test(k)) err(p, 'nothing is counted in ticks; durations are microseconds, rates per second');
    scan(x, p, err);
  }
}

function section(entry, key, err) {
  const v = entry[key];
  if (v === undefined) return {};
  if (!isObj(v)) { err(key, 'a table of name to value'); return {}; }
  for (const name of Object.keys(v)) if (!IDENT.test(name)) err(`${key}.${name}`, 'a name is lower_snake_case');
  return v;
}

function only(obj, keys, path, err) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) err(`${path}.${k}`, `unknown key; expected ${keys.join(', ')}`);
}

function numbered(table, key, err) {
  const seen = new Map();
  for (const [name, f] of Object.entries(table)) {
    if (!isObj(f)) continue;
    if (!(isInt(f.n) && f.n > 0)) { err(`${key}.${name}.n`, 'every field has a stable number, a whole number above zero'); continue; }
    if (seen.has(f.n)) err(`${key}.${name}.n`, `number ${f.n} is already ${seen.get(f.n)}'s`);
    seen.set(f.n, name);
  }
}

/** Check one audience rule. `links` is this kind's link table, so a `linked` rule can only name a link the kind has. */
function rule(a, path, links, err) {
  if (!isObj(a)) { err(path, `a rule is an object, {"rule": one of ${AUDIENCE_RULES.join(', ')}}`); return; }
  if (!AUDIENCE_RULES.includes(a.rule)) { err(`${path}.rule`, `must be one of ${AUDIENCE_RULES.join(', ')}`); return; }
  only(a, a.rule === 'linked' ? ['rule', 'link'] : ['rule'], path, err);
  if (a.rule === 'linked' && !(typeof a.link === 'string' && a.link in links)) err(`${path}.link`, 'names a link type of this kind (a rule never names a Soul)');
}

function audience(obj, path, links, err) {
  if (obj.audience === undefined) err(`${path}.audience`, 'every field says who may see it; the default is written out, never implied');
  else rule(obj.audience, `${path}.audience`, links, err);
}

/** The rule that decides who may see a state field: its own, or, when the kind is closed and names it, the container's. */
export function audienceOf(entry, name) {
  if (entry.closed?.fields?.includes(name)) return entry.closed.audience;
  return entry.state?.[name]?.audience;
}

/** A closed kind: the fields it names (stock counts) and its children take the container's own audience until it is opened (Engine v2 E22, #2792). */
function closed(c, state, links, err) {
  if (!isObj(c)) { err('closed', 'an object: {"audience": rule, "fields": [state field names]}'); return; }
  only(c, ['audience', 'fields'], 'closed', err);
  if (c.audience === undefined) err('closed.audience', 'the container\'s own audience, written out');
  else rule(c.audience, 'closed.audience', links, err);
  if (!Array.isArray(c.fields)) { err('closed.fields', 'a list of state field names'); return; }
  c.fields.forEach((n, i) => { if (!(n in state)) err(`closed.fields.${i}`, `"${n}" is not a state field of this kind`); });
}

/** The kinds this thing holds as child nodes (a sign-up sheet's slots, a board's squares): a record that points at a
 *  Soul or a thing is a child with a link, not a list item (Engine v2 F11, #2774). */
function children(table, err) {
  for (const [name, c] of Object.entries(table)) {
    const p = `children.${name}`;
    if (!isObj(c)) { err(p, 'a child is an object: {"kind": "namespace:name", "most": a whole number}'); continue; }
    only(c, ['kind', 'most'], p, err);
    if (!(typeof c.kind === 'string' && KIND.test(c.kind))) err(`${p}.kind`, 'a kind, "namespace:name"');
    if (!(isInt(c.most) && c.most > 0)) err(`${p}.most`, 'how many children at most, a whole number above zero');
  }
}

/** A list: one field, a declared bound, records of small values. Changed by setting the whole list again. */
function listField(f, path, err) {
  only(f, ['n', 'type', 'default', 'audience', 'of', 'most', 'key'], path, err);
  if (!(isInt(f.most) && f.most > 0 && f.most <= LIST_MOST)) err(`${path}.most`, `the most items it ever holds, a whole number from 1 to ${LIST_MOST}`);
  if (!Array.isArray(f.default) || f.default.length) err(`${path}.default`, 'an empty list');
  const of = f.of;
  if (!isObj(of) || !Object.keys(of).length || Object.keys(of).length > RECORD_FIELDS_MOST) { err(`${path}.of`, `a record: one to ${RECORD_FIELDS_MOST} named small fields`); return; }
  for (const [name, r] of Object.entries(of)) {
    const p = `${path}.of.${name}`;
    if (!IDENT.test(name)) { err(p, 'a name is lower_snake_case'); continue; }
    if (!isObj(r)) { err(p, 'a record field is an object'); continue; }
    only(r, ['type', 'values', 'unit'], p, err);
    if (ID_TYPES.has(r.type)) err(`${p}.type`, `"${r.type}" would put an id inside a record; a Soul or a thing is a child node with a link, not a list item`);
    else if (!RECORD_TYPES.includes(r.type)) err(`${p}.type`, `must be one of ${RECORD_TYPES.join(', ')} (a record holds small values only)`);
    else {
      if (r.type === 'enum' && !(Array.isArray(r.values) && r.values.length >= 2 && r.values.every(x => typeof x === 'string' && IDENT.test(x)))) err(`${p}.values`, 'two or more lower_snake_case values');
      if (r.type === 'int' && !UNITS.includes(r.unit)) err(`${p}.unit`, `a whole-number unit (${UNITS.join(', ')})`);
      if (r.type !== 'enum' && r.values !== undefined) err(`${p}.values`, 'only an enum has values');
      if (r.type !== 'int' && r.unit !== undefined) err(`${p}.unit`, 'only an int has a unit');
    }
  }
  if (f.key !== undefined && !(typeof f.key === 'string' && f.key in of)) err(`${path}.key`, 'names a field of the record; items are added, removed and set by it');
}

/** What a kind's state costs at its declared bounds: whole values counted with every list at its maximum. The check
 *  gate measures a kind here, never at the empty default (SA-F6a, #2846). */
export function stateAtMax(entry) {
  let values = 0, listValues = 0;
  for (const f of Object.values(entry.state ?? {})) {
    if (f.type === 'list') { const n = f.most * Object.keys(f.of ?? {}).length; values += n; listValues += n; }
    else values += 1;
  }
  return {values, listValues, children: Object.values(entry.children ?? {}).reduce((a, c) => a + c.most, 0)};
}

function vec(v, path, err, positive = false) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(x => isInt(x) && (!positive || x > 0))) err(path, `three whole numbers of millimetres${positive ? ' above zero' : ''}`);
}

function field(f, path, links, err, taken = false) {
  if (!isObj(f)) { err(path, 'a field is an object'); return; }
  if (f.type !== 'list') only(f, ['n', 'type', 'default', 'audience', 'values', 'unit', 'min', 'max'], path, err);
  if (taken) { if (f.audience !== undefined) err(`${path}.audience`, 'this field takes the container\'s audience (closed); it declares none of its own'); }
  else audience(f, path, links, err);
  if (ID_TYPES.has(f.type)) { err(`${path}.type`, `"${f.type}" would put an id inside a field; a relation is a link (links section)`); return; }
  if (!FIELD_TYPES.includes(f.type)) { err(`${path}.type`, `must be one of ${FIELD_TYPES.join(', ')}`); return; }
  if (f.type === 'list') { listField(f, path, err); return; }
  if (!('default' in f)) err(`${path}.default`, 'every field has a default');
  const d = f.default;
  if (f.type === 'bool' && typeof d !== 'boolean') err(`${path}.default`, 'true or false');
  if (f.type === 'enum') {
    if (!Array.isArray(f.values) || f.values.length < 2 || !f.values.every(x => typeof x === 'string' && IDENT.test(x))) err(`${path}.values`, 'two or more lower_snake_case values');
    else if (!f.values.includes(d)) err(`${path}.default`, 'one of its values');
  }
  if (f.type === 'int') {
    const rate = typeof f.unit === 'string' && f.unit.endsWith('/s') ? f.unit.slice(0, -2) : f.unit;
    if (!UNITS.includes(rate)) err(`${path}.unit`, `a whole-number unit (${UNITS.join(', ')}), or a rate per second written <unit>/s`);
    if (!isInt(d)) err(`${path}.default`, 'a whole number');
  }
  if (f.type === 'duration' && !(isInt(d) && d >= 0)) err(`${path}.default`, 'whole microseconds');
  if (f.type === 'text' && d !== null) err(`${path}.default`, 'null; inline words in state are refused, a text field holds a reference once written');
  if (f.type !== 'enum' && f.values !== undefined) err(`${path}.values`, 'only an enum has values');
  if (f.type !== 'int' && f.unit !== undefined) err(`${path}.unit`, 'only an int has a unit');
}

const isArg = v => isObj(v) && Object.keys(v).length === 1 && typeof v.arg === 'string';

function form(f, path, ctx, err) {
  if (!isObj(f)) { err(path, 'a form is an object'); return; }
  only(f, ['who', 'starts', 'takes', 'needs', 'steps', 'effects'], path, err);
  const takes = isObj(f.takes) ? f.takes : {};
  if (f.takes !== undefined && !isObj(f.takes)) err(`${path}.takes`, 'a table of argument name to type');
  for (const [name, a] of Object.entries(takes)) {
    const p = `${path}.takes.${name}`;
    if (!IDENT.test(name) || !isObj(a)) { err(p, 'an argument is a lower_snake_case name and an object'); continue; }
    only(a, ['type', 'select'], p, err);
    if (!ARG_TYPES.includes(a.type)) err(`${p}.type`, `must be one of ${ARG_TYPES.join(', ')}`);
    if (a.select !== undefined) select(a.select, `${p}.select`, err);
  }
  const arg = (v, p, types) => {
    if (!(v.arg in takes)) err(p, `argument "${v.arg}" is not in takes`);
    else if (types && !types.includes(takes[v.arg].type)) err(p, `argument "${v.arg}" must be of type ${types.join(' or ')}`);
  };
  const place = (v, p) => {
    if (isArg(v)) arg(v, p, ['slot', 'part', 'thing']);
    else if (!(typeof v === 'string' && (v in ctx.points || v in ctx.slots))) err(p, 'names a point or slot of this kind, or an argument');
  };
  const slot = (v, p) => { if (isArg(v)) arg(v, p, ['slot']); else if (!(v in ctx.slots)) err(p, 'names a slot of this kind, or an argument'); };
  const fieldName = (v, p) => { if (!(typeof v === 'string' && v in ctx.state)) err(p, 'names a state field of this kind'); };
  const linkName = (v, p) => { if (!(typeof v === 'string' && v in ctx.links)) err(p, 'names a link type of this kind'); };
  const value = (fname, v, p) => {
    const fd = ctx.state[fname];
    if (isArg(v)) {
      arg(v, p);
      const at = takes[v.arg]?.type;
      // Words are kept by reference (contract T8, #2662): only a text argument reaches a text field, and nothing else does.
      if (fd && at && (fd.type === 'text') !== (at === 'text')) err(p, fd.type === 'text' ? `argument "${v.arg}" is ${at}; a text field is set from a text argument (a reference)` : `argument "${v.arg}" is text; field "${fname}" is ${fd.type}, and a text argument goes only to a text field`);
      return;
    }
    if (!fd) return;
    if (fd.type === 'text' && v !== null) { err(p, 'inline words in state; a text field holds a reference, so set it from a text argument (or null to clear it)'); return; }
    const ok = fd.type === 'bool' ? typeof v === 'boolean' : fd.type === 'enum' ? fd.values?.includes(v) : fd.type === 'int' || fd.type === 'duration' ? isInt(v) : v === null;
    if (!ok) err(p, `not a value of field "${fname}" (${fd.type})`);
  };

  if (typeof f.who === 'string') { if (!WHO.includes(f.who)) err(`${path}.who`, `one of ${WHO.join(', ')}, or {"link": <link type>}`); }
  else if (isObj(f.who)) { only(f.who, ['link'], `${path}.who`, err); linkName(f.who.link, `${path}.who.link`); }
  else err(`${path}.who`, 'who may: required');
  if (!STARTS.includes(f.starts)) err(`${path}.starts`, `one of ${STARTS.join(', ')}`);
  if ((f.starts === 'timer') !== (f.who === 'world')) err(`${path}.who`, 'a form started by a timer is the world\'s, and only such a form is');

  list(f.needs, `${path}.needs`, 'need', NEEDS, err, (n, p) => {
    if (n.need === 'state') {
      only(n, ['need', 'field', 'is', 'not'], p, err);
      fieldName(n.field, `${p}.field`);
      if (('is' in n) === ('not' in n)) err(p, 'exactly one of is, not');
      else value(n.field, 'is' in n ? n.is : n.not, `${p}.${'is' in n ? 'is' : 'not'}`);
    } else if (n.need === 'slot_free') { only(n, ['need', 'slot'], p, err); slot(n.slot, `${p}.slot`); }
    else if (n.need === 'within_reach') { only(n, ['need', 'point'], p, err); place(n.point, `${p}.point`); }
    else if (n.need === 'held_by_actor') only(n, ['need'], p, err);
    else { only(n, ['need', 'link'], p, err); linkName(n.link, `${p}.link`); }
  });
  list(f.steps, `${path}.steps`, 'step', STEPS, err, (s, p) => {
    if (s.step === 'walk_to') { only(s, ['step', 'point'], p, err); place(s.point, `${p}.point`); }
    else if (s.step === 'sit') { only(s, ['step', 'slot'], p, err); slot(s.slot, `${p}.slot`); }
    else if (s.step === 'move') {
      only(s, ['step', 'move', 'at', 'toward'], p, err);
      if (typeof s.move !== 'string' || !IDENT.test(s.move)) err(`${p}.move`, 'names a move (moves are data, SA-D4)');
      if (s.at !== undefined) place(s.at, `${p}.at`);
      if (s.toward !== undefined && !isArg(s.toward)) err(`${p}.toward`, 'an argument');
      else if (s.toward !== undefined) arg(s.toward, `${p}.toward`, ['thing', 'slot', 'part']);
    } else if (s.step === 'take' || s.step === 'put') { only(s, ['step', 'slot'], p, err); if (s.slot !== undefined) slot(s.slot, `${p}.slot`); }
    else if (s.step === 'wait') { only(s, ['step', 'us'], p, err); if (!(isInt(s.us) && s.us > 0)) err(`${p}.us`, 'a pause of a stated length, whole microseconds above zero; never a wait for a time or a condition'); }
    else only(s, ['step'], p, err);
  });
  list(f.effects, `${path}.effects`, 'change', CHANGES, err, (e, p) => {
    if (typeof e.event !== 'string' || !IDENT.test(e.event)) err(`${p}.event`, 'every effect names its event, lower_snake_case');
    if (e.change === 'set') { only(e, ['change', 'field', 'to', 'event'], p, err); fieldName(e.field, `${p}.field`); if (!('to' in e)) err(`${p}.to`, 'required'); else value(e.field, e.to, `${p}.to`); }
    else if (e.change === 'reparent') {
      only(e, ['change', 'what', 'into', 'event'], p, err);
      if (!SUBJECTS.includes(e.what)) err(`${p}.what`, `one of ${SUBJECTS.join(', ')}`);
      if (e.into !== 'actor_hand') slot(e.into, `${p}.into`);
    } else if (e.change === 'link' || e.change === 'unlink') {
      only(e, ['change', 'link', 'from', 'event'], p, err);
      linkName(e.link, `${p}.link`);
      if (e.from !== 'actor') err(`${p}.from`, 'actor');
    } else if (e.change === 'create') {
      only(e, ['change', 'kind', 'into', 'event'], p, err);
      if (typeof e.kind !== 'string' || !KIND.test(e.kind)) err(`${p}.kind`, 'a kind, "namespace:name"');
      if (e.into !== 'here' && e.into !== 'actor_hand') slot(e.into, `${p}.into`);
    } else if (e.change === 'remove') { only(e, ['change', 'what', 'event'], p, err); if (!SUBJECTS.includes(e.what)) err(`${p}.what`, `one of ${SUBJECTS.join(', ')}`); }
    else if (e.change === 'timer') {
      only(e, ['change', 'form', 'after_us', 'event'], p, err);
      if (ctx.forms[e.form]?.starts !== 'timer') err(`${p}.form`, 'names a form of this kind that a timer starts');
      if (!(isInt(e.after_us) && e.after_us > 0)) err(`${p}.after_us`, 'whole microseconds above zero');
    }
  });
}

function list(arr, path, tag, kinds, err, each) {
  if (!Array.isArray(arr)) { err(path, 'a list (empty if none)'); return; }
  arr.forEach((x, i) => {
    const p = `${path}.${i}`;
    if (!isObj(x)) err(p, 'an object');
    else if (!kinds.includes(x[tag])) err(`${p}.${tag}`, `"${x[tag]}" is not in the closed list (${kinds.join(', ')}); the task that needs a new one adds it`);
    else each(x, p);
  });
}

function select(s, path, err) {
  if (!isObj(s)) { err(path, 'a selector is an object'); return; }
  only(s, ['of', 'kind', 'in', 'anchor', 'order', 'rank'], path, err);
  for (const k of Object.keys(SELECT)) if (!SELECT[k].includes(s[k])) err(`${path}.${k}`, `one of ${SELECT[k].join(', ')}`);
  if (s.kind !== undefined && !(typeof s.kind === 'string' && KIND.test(s.kind))) err(`${path}.kind`, 'a kind, "namespace:name"');
  if (!(s.rank === 'last' || (isInt(s.rank) && s.rank > 0))) err(`${path}.rank`, 'a whole number from 1, or "last"');
}

// ---- The provisional hash ---------------------------------------------------------------------------------------
// Until Engine v2's encoding (T0) exists, the hash is SHA-256 over a canonical JSON form: sections by number, keys
// sorted, no spacing, with a purpose label in front. It is written `prov-` + multihash code 0x12, length 0x20, digest.
// It WILL change once, when the real encoding lands: nothing may store it as permanent.
export const HASH_LABEL = 'souls/kind/provisional/1\n';
export const BESIDE_LABEL = 'souls/kind-beside/provisional/1\n';

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const digest = (label, body) => `prov-1220${createHash('sha256').update(label + body).digest('hex')}`;

/** The kinds an entry refers to by name: what it creates and what its selectors pick among. */
export function kindRefs(entry) {
  const refs = new Set();
  const walk = v => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (k === 'kind' && typeof x === 'string' && KIND.test(x)) refs.add(x); else walk(x); }
  };
  walk(entry.forms);
  for (const c of Object.values(entry.children ?? {})) if (isObj(c) && typeof c.kind === 'string') refs.add(c.kind);
  return [...refs].sort();
}

function split(entry, resolve) {
  const meaning = {}, beside = {};
  for (const [k, v] of Object.entries(entry)) (SECTIONS[k] >= BESIDE_FROM ? beside : meaning)[SECTIONS[k]] = v;
  // A referenced kind is covered by its own hash, so a change of meaning there renames this kind too.
  meaning.refs = kindRefs(entry).map(resolve);
  return {meaning, beside};
}

/** Hash every entry, resolving the kinds each refers to. Throws, naming them, if a referenced kind is missing or if
 *  kinds refer to each other in a circle. Returns kind name -> {ref, hash, beside}. */
export function hashKinds(entries) {
  const byName = new Map(entries.map(e => [e.kind, e]));
  const done = new Map(), visiting = [];
  const visit = name => {
    if (done.has(name)) return done.get(name).ref;
    if (visiting.includes(name)) throw new Error(`kinds refer to each other in a circle: ${[...visiting.slice(visiting.indexOf(name)), name].join(' -> ')}`);
    const entry = byName.get(name);
    if (!entry) throw new Error(`refers to a kind that is not loaded: ${name} (from ${visiting.at(-1)})`);
    visiting.push(name);
    const {meaning, beside} = split(entry, visit);
    visiting.pop();
    const hash = digest(HASH_LABEL, canonical(meaning));
    const out = {ref: `${name}@${hash}`, hash, beside: digest(BESIDE_LABEL, canonical(beside)), provisional: true};
    done.set(name, out);
    return out.ref;
  };
  for (const e of entries) visit(e.kind);
  return done;
}

export function loadDir(dir) {
  const files = [];
  const walk = p => statSync(p).isDirectory() ? readdirSync(p).sort().forEach(f => walk(join(p, f))) : p.endsWith('.json') && files.push(p);
  walk(dir);
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2).flatMap(loadDir);
  const rows = files.map(file => {
    const {entry, errors} = parseEntry(readFileSync(file, 'utf8'));
    return {file, entry, errors: entry ? [...errors, ...validateEntry(entry)] : errors};
  });
  let hashes = new Map(), hashError;
  try { hashes = hashKinds(rows.filter(r => !r.errors.length).map(r => r.entry)); } catch (e) { hashError = e.message; }
  for (const r of rows) console.log(JSON.stringify({file: r.file, kind: r.entry?.kind, ref: hashes.get(r.entry?.kind)?.ref, provisional: true, errors: r.errors}));
  if (hashError) console.log(JSON.stringify({error: hashError}));
  process.exitCode = rows.some(r => r.errors.length) || hashError ? 1 : 0;
}
