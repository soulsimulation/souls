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
 *  meaning and are covered by its hash; sections 20 and up sit beside it under their own hash (contract T3, #2640).
 *  Section 10 is Engine v2 T3's table of referenced kinds, written by the encoder, never in a file; 12 is `reactions`. */
export const SECTIONS = Object.freeze({format: 0, kind: 1, owner: 2, state: 3, links: 4, points: 5, slots: 6, geometry: 7, forms: 8, closed: 9, children: 11, vehicle: 13, ride: 14, stock: 15, areas: 16, roles: 17,
  looks: 20, text: 21, card: 22, howtos: 23});
export const BESIDE_FROM = 20;
/** Sections a later task defines. Until it lands, an entry that carries one is refused with that task's name. */
export const RESERVED = Object.freeze({reactions: 'SA-F15', motion: 'SA-F10', loose: 'SA-F10', hatch: 'SA-F9'});

/** What a kind is the kind of: a thing, a body's family, or a kind of ground or place (Engine v2 E21, #2791). */
export const OWNERS = Object.freeze(['thing', 'family', 'place']);
export const FIELD_TYPES = Object.freeze(['bool', 'enum', 'int', 'duration', 'text', 'list', 'schedule', 'timed']);
/** A timed value (SA-F5a, #2845): a value that changes with time, stored as three whole numbers: `value` (in the field's
 *  unit), `per_s` (the rate, in that unit per second) and `set_us` (the world time it was set). */
export const TIMED_KEYS = Object.freeze(['value', 'per_s', 'set_us']);
/** A schedule is data a kind publishes (SA-F16, #2854): a bounded list of times a client reads and plans from. The world
 *  never waits for one and never reminds a mind of one. A `once` entry runs between two world times; a `weekly` entry
 *  repeats on named days between two local times of day (the clock of the place the thing stands in). */
export const SCHEDULE_REPEATS = Object.freeze(['once', 'weekly']);
export const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const DAY_US = 86_400_000_000;
/** What a form never carries: a start time or a wait for a condition. When to act is the agent's client's business. */
const WHEN_KEY = /^(?:at|at_us|time|date|day|days|weekday|start|start_us|starts_at|from_us|to_us|until|until_us|deadline|not_before|schedule|repeat|when|while|unless|if|condition|wait_for|wait_until)$/;
const WHEN_NAME = /^(?:time|clock|date|weekday|after|before|until|schedule|at_time|open_now|wait_until|wait_for|wait_for_time|wait_for_condition)$/;
const WHEN_REASON = 'a form carries no start time and waits for no condition; when to act is the agent\'s own business, so the kind publishes a schedule field and the client reads it';
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
/** A row's ends: the first and the last place of a row of slots, found by `place` (SA-D3, #2855). */
export const ROW_ENDS = Object.freeze(['first', 'last']);
/** How far outside the thing's bounds a point may lie, in millimetres. A grip, a button or a spout may stand a little proud of
 *  the box (a handle, a lip); a place to stand is by the thing, within a body's reach of it. The frame is the thing's own:
 *  the origin at the centre of its footprint on the ground, x right, y up, z to the front; `bounds_mm` is [width, height,
 *  depth], so x runs from -width/2 to width/2, y from 0 to height, z from -depth/2 to depth/2. */
export const POINT_MARGIN_MM = 100;
export const STAND_MARGIN_MM = 2000;
export const POSTURES = Object.freeze(['sit', 'lie']);
export const WHO = Object.freeze(['anyone', 'holder', 'world']);
export const STARTS = Object.freeze(['act', 'timer']);
export const ARG_TYPES = Object.freeze(['slot', 'part', 'thing', 'text', 'duration', 'count']);
/** A described target: one closed list with Engine v2 E2 (#2709): a candidate set, an anchor, an order and a rank. */
export const SELECT = Object.freeze({of: ['things', 'free_slots'], in: ['this', 'here', 'parent'], anchor: ['me', 'this'], order: ['nearest', 'furthest']});
/** The closed lists. Each grows only with the task that first needs a new member. */
export const NEEDS = Object.freeze(['state', 'slot_free', 'within_reach', 'held_by_actor', 'hand', 'linked', 'unlinked', 'room']);
/** `settle`: a body takes a ground posture where it stands, with no slot (SA-G3, #2875). */
export const STEPS = Object.freeze(['walk_to', 'sit', 'rise', 'move', 'take', 'put', 'use_held', 'wait', 'settle']);
/** `transfer` moves an amount between two int fields of one name (SA-F2b, #2844); `draw` is an outcome nobody chose,
 *  from a weighted table the world draws from (SA-F13, #2852). */
export const CHANGES = Object.freeze(['set', 'reparent', 'link', 'unlink', 'create', 'remove', 'timer', 'transfer', 'draw']);
/** An activity's roles (SA-G1a, #2872; Engine v2 B5, #2724): how much a role is needed, and where its members may be. */
export const ROLE_NEEDS = Object.freeze(['required', 'replaceable', 'optional']);
export const PLACES_IN = Object.freeze(['this', 'here']);
/** The link a body declares to its Soul (SA-F7a, #2848), so who-may can match a Soul to the body that acts. */
export const SOUL_LINK = 'soul';
export const SUBJECTS = Object.freeze(['actor', 'this']);
/** A vehicle (SA-F14, #2884) declares what Engine v2 needs to let a Soul drive it, never how it moves: a drive seat, a speed,
 *  its size (the bounds) and the kind of ground it may cross. Ground is whole kinds: `level` (no doors, stairs or ladders)
 *  or `deep_water` (deep enough to swim in). A ride is a set trip between stops that nobody steers (a sail). */
export const VEHICLE_GROUNDS = Object.freeze(['level', 'deep_water']);
/** Where a rider may step off: ground to stand on, water to swim in, or somewhere neither holds. */
export const SPOTS = Object.freeze(['level', 'shallow', 'deep_water', 'door', 'stairs', 'ladder', 'blocked']);
export const SPOTS_STAND = Object.freeze(['level', 'shallow']);
export const SPOTS_SWIM = Object.freeze(['deep_water']);

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
  stock(entry, err);
  areas(entry, err);
  roles(entry, err);
  if (entry.vehicle !== undefined) vehicle(entry, err);
  if (entry.ride !== undefined) ride(entry, err);
  if (entry.vehicle !== undefined && entry.ride !== undefined) err('ride', 'a kind is a vehicle (steered) or a ride (a set trip), not both');
  for (const [name, l] of Object.entries(links)) {
    const p = `links.${name}`;
    if (!isObj(l)) { err(p, 'a link type is an object'); continue; }
    only(l, ['n', 'from', 'most', 'most_per', 'audience'], p, err);
    if (!(LINK_ENDS.includes(l.from) || (typeof l.from === 'string' && KIND.test(l.from)))) err(`${p}.from`, `must be one of ${LINK_ENDS.join(', ')}, or a kind "namespace:name"`);
    if (l.most !== undefined && !(isInt(l.most) && l.most > 0)) err(`${p}.most`, 'how many may be linked at the from end to one of these, a whole number above zero');
    if (l.most_per !== undefined && !(isInt(l.most_per) && l.most_per > 0)) err(`${p}.most_per`, 'how many of these one from end may be linked to, a whole number above zero');
    audience(l, p, links, err);
    if (name === SOUL_LINK && !(entry.owner === 'family' && l.from === 'soul' && l.most === 1)) err(p, 'the soul link is a body\'s link to its Soul: declared by a body\'s family (owner "family"), from "soul", most 1');
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
    only(s, ['admits', 'posture', 'most', 'at_mm', 'stand', 'fits_mm', 'kinds', 'row', 'place', 'end'], p, err);
    if (!SLOT_ADMITS.includes(s.admits)) err(`${p}.admits`, `must be one of ${SLOT_ADMITS.join(', ')}`);
    if (s.posture !== undefined && (s.admits !== 'body' || !POSTURES.includes(s.posture))) err(`${p}.posture`, `a body's slot only, one of ${POSTURES.join(', ')}`);
    if (!(isInt(s.most) && s.most > 0)) err(`${p}.most`, 'how many it admits, a whole number above zero');
    vec(s.at_mm, `${p}.at_mm`, err);
    if (s.fits_mm !== undefined) vec(s.fits_mm, `${p}.fits_mm`, err, true);
    if (s.stand !== undefined && points[s.stand]?.role !== 'stand') err(`${p}.stand`, 'names a point whose role is stand');
    if (s.kinds !== undefined && !(s.admits === 'thing' && Array.isArray(s.kinds) && s.kinds.length > 0 && s.kinds.every(k => typeof k === 'string' && KIND.test(k)))) err(`${p}.kinds`, 'a thing slot only: the kinds it admits, a list of "namespace:name" (none listed admits any thing)');
  }
  rows(slots, err);
  places(entry, points, slots, err);
  if (entry.geometry !== undefined) {
    if (!isObj(entry.geometry)) err('geometry', 'an object');
    else { only(entry.geometry, ['bounds_mm'], 'geometry', err); vec(entry.geometry.bounds_mm, 'geometry.bounds_mm', err, true); }
  }

  const ctx = {state, links, points, slots, forms, areas: isObj(entry.areas) ? entry.areas : {}};
  for (const [name, f] of Object.entries(forms)) {
    if (!IDENT.test(name)) err(`forms.${name}`, 'a form name is lower_snake_case');
    form(f, `forms.${name}`, ctx, err);
  }
  for (const [key, v] of Object.entries(text)) if (typeof v !== 'string' || !IDENT.test(key)) err(`text.${key}`, 'text is a table of name to words');
  if (entry.looks !== undefined && !isObj(entry.looks)) err('looks', 'an object (its table is SA-D1a\'s)');
  if (entry.card !== undefined) card(entry.card, text, err);
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

// A card is the line a search ranks a kind on: its purpose (its length is the check's rule), one category word and
// synonyms. All are words, so all are named by reference to the text table.
function card(c, text, err) {
  if (!isObj(c)) { err('card', 'an object'); return; }
  only(c, ['text', 'category', 'synonyms'], 'card', err);
  if (!(typeof c.text === 'string' && c.text in text)) err('card.text', 'names an entry of the text table');
  if (c.category !== undefined) {
    if (!(typeof c.category === 'string' && c.category in text)) err('card.category', 'names an entry of the text table (one word)');
    else if (/\s/.test(text[c.category].trim())) err('card.category', 'one word: its text entry has more than one');
  }
  if (c.synonyms !== undefined) {
    if (!Array.isArray(c.synonyms) || c.synonyms.length === 0) err('card.synonyms', 'a list of names of the text table');
    else c.synonyms.forEach((k, i) => { if (!(typeof k === 'string' && k in text)) err(`card.synonyms.${i}`, 'names an entry of the text table (the words themselves are not written here)'); });
  }
}

function only(obj, keys, path, err) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) err(`${path}.${k}`, path.startsWith('forms.') && WHEN_KEY.test(k) ? `${WHEN_REASON} (unknown key "${k}")` : `unknown key; expected ${keys.join(', ')}`);
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

/** Stock: the things a container is known to hold, yielded when taken (SA-F12, #2851). A stock is a count in an int
 *  state field that is capped at both ends, so it runs out; taking makes one thing in the actor's hand and lowers the
 *  count in the same batch; it may refill, one more every so long, up to its cap. Free to take for now: buying, lending
 *  and debts are not here. What a stocked thing carries by reference (a book's title and first page) comes from a
 *  library the world's creator supplies; the entry only names the text fields. */
export const STOCK_KEYS = ['kind', 'count', 'take', 'carries', 'refill'];
function stock(entry, err) {
  const table = section(entry, 'stock', err), state = section(entry, 'state', err), forms = section(entry, 'forms', err);
  for (const [name, s] of Object.entries(table)) {
    const p = `stock.${name}`;
    if (!IDENT.test(name)) err(p, 'a stock name is lower_snake_case');
    if (!isObj(s)) { err(p, 'a stock is an object: {"kind", "count", "take", "carries", "refill"}'); continue; }
    only(s, STOCK_KEYS, p, err);
    if (entry.owner !== 'thing') err(p, 'a thing holds stock');
    if (!(typeof s.kind === 'string' && KIND.test(s.kind))) err(`${p}.kind`, 'the kind it yields, "namespace:name"');
    const f = state[s.count];
    if (!(typeof s.count === 'string' && isObj(f))) err(`${p}.count`, 'names a state field of this kind: how many are left');
    else if (!(f.type === 'int' && f.unit === 'count' && f.min === 0 && isInt(f.max) && f.max > 0 && isInt(f.default) && f.default >= 0 && f.default <= f.max)) err(`${p}.count`, `"${s.count}" is an int field in unit count with a min of 0 and a max above 0, its default within them: stock is a count and it runs out`);
    if (s.carries !== undefined && !(Array.isArray(s.carries) && s.carries.length > 0 && s.carries.length <= 4 && s.carries.every(c => typeof c === 'string' && IDENT.test(c)))) err(`${p}.carries`, 'one to four text fields of the yielded kind that come by reference from the world\'s library (a book\'s title and first page)');
    if (s.refill !== undefined) {
      if (!isObj(s.refill)) err(`${p}.refill`, 'an object: {"every_us": whole microseconds}');
      else { only(s.refill, ['every_us'], `${p}.refill`, err); if (!(isInt(s.refill.every_us) && s.refill.every_us > 0)) err(`${p}.refill.every_us`, 'one more every this long, whole microseconds above zero'); }
    }
    const t = forms[s.take], tp = `${p}.take`;
    if (!(typeof s.take === 'string' && isObj(t))) { err(tp, 'names the form of this kind that takes one'); continue; }
    const needs = Array.isArray(t.needs) ? t.needs : [], effects = Array.isArray(t.effects) ? t.effects : [];
    if (t.starts !== 'act' || !(t.who === 'anyone' || t.who === 'holder')) err(tp, 'the take form is a Soul\'s act (starts "act") that anyone, or the holder, may do');
    if (!needs.some(n => n?.need === 'state' && n.field === s.count && isInt(n.at_least) && n.at_least >= 1)) err(tp, `the take form needs {"need": "state", "field": "${s.count}", "at_least": 1}: an empty stock refuses`);
    if (!needs.some(n => n?.need === 'hand' && n.free === true)) err(tp, 'the take form needs a free hand: {"need": "hand", "free": true}');
    const makes = effects.filter(e => e?.change === 'create');
    if (!(makes.length === 1 && makes[0].kind === s.kind && makes[0].into === 'actor_hand')) err(tp, `the take form makes one ${s.kind} into the actor's hand (a create into "actor_hand")`);
    if (effects.some(e => e?.change === 'set' && e.field === s.count)) err(tp, `the take form does not set "${s.count}": the engine lowers it by one in the same batch as the make`);
  }
}

/** What a container lists as its stock: [{stock, kind, count, carries}] once the count may be read, else `null`. A kind
 *  whose count is a closed field shows it only once it is opened (Engine v2 E22); a shelf or a stall is always open.
 *  `fields` is the thing's state by field name. */
export function stockOf(entry, {fields = {}, opened = false} = {}) {
  const hidden = new Set(isObj(entry?.closed) && Array.isArray(entry.closed.fields) ? entry.closed.fields : []);
  const out = [];
  for (const [name, s] of Object.entries(entry?.stock ?? {})) {
    if (hidden.has(s.count) && !opened) return null;
    out.push({stock: name, kind: s.kind, count: s.count in fields ? fields[s.count] : entry.state[s.count].default, carries: s.carries ?? []});
  }
  return out;
}

/** Taking one from stock `name`: refused as `closed` (not opened) or `empty` (the count is 0), with a reason in words; else
 *  the generic changes of one batch (contract T6): one thing made into the hand and the count lowered by one, so nothing
 *  is made from nothing. `made` is the new node's id, `receipt` the act's. */
export function takeStock(entry, {name, fields = {}, opened = false, receipt, hand = 'hand'}) {
  const s = entry?.stock?.[name];
  if (!s) return {ok: false, code: 'no_such_stock', reason: `${entry?.kind} holds no stock called "${name}"`};
  if (stockOf(entry, {fields, opened}) === null) return {ok: false, code: 'closed', reason: `${entry.kind} is closed; open it to take from it`};
  const left = s.count in fields ? fields[s.count] : entry.state[s.count].default;
  if (left < 1) return {ok: false, code: 'empty', reason: `${entry.kind} is empty: no ${s.kind} is left`};
  const made = `${receipt}.0`;
  return {ok: true, made, carries: s.carries ?? [], changes: [
    {change: 'create', node: made, kind: s.kind, to: {hand}},
    {change: 'set', field: s.count, n: entry.state[s.count].n, to: left - 1, by: -1}], event: s.take};
}

/** The count a refill reaches `us` microseconds after the count was `count`: one more every `every_us`, never above its cap. */
export function refilled(entry, name, count, us) {
  const s = entry.stock[name], cap = entry.state[s.count].max;
  return s.refill ? Math.min(cap, count + Math.floor(us / s.refill.every_us)) : count;
}

/** Areas (SA-D6, #2861): what a kind says about resting on it, or about a part of its surroundings, where its shape cannot.
 *  Engine v2 E3 (#2777) reads a declared area first, then surfaces, then shape, so a kind writes an area only where shape
 *  gives the wrong answer or none: a bed is for lying and sitting on its edge, a piano is for neither, a tree has shade.
 *  An area may carry `allows` (posture -> `on` the thing or on its `edge`), `forbids` (postures, by name), `takes` (kinds of
 *  thing that may be set down on it, Engine v2 E4) and a place: `at_mm` and `radius_mm`, whole millimetres in the thing's
 *  own frame, a named part of its surroundings a body can be sent to (`walk_to`). The spot a body or thing gets is the
 *  engine's choice. An area that only repeats what the kind's slots already say is refused. */
export const REST_POSTURES = Object.freeze(['sit', 'lie', 'stand', 'lean']);
export const REST_WHERE = Object.freeze(['on', 'edge']);
export const AREA_KEYS = ['allows', 'forbids', 'takes', 'at_mm', 'radius_mm'];
export const AREA_REACH_MM = 20000;
function areas(entry, err) {
  const table = section(entry, 'areas', err), points = section(entry, 'points', err), slots = section(entry, 'slots', err);
  const slotList = Object.values(slots).filter(isObj);
  for (const [name, a] of Object.entries(table)) {
    const p = `areas.${name}`;
    if (name in points || name in slots) err(p, `"${name}" is already a ${name in points ? 'point' : 'slot'}; a part's name is used once`);
    if (!isObj(a)) { err(p, 'an area is an object: {"allows", "forbids", "takes", "at_mm", "radius_mm"}'); continue; }
    only(a, AREA_KEYS, p, err);
    if (!(entry.owner === 'thing' || entry.owner === 'place')) err(p, 'a thing or a place declares areas');
    const allows = isObj(a.allows) ? a.allows : {}, forbids = Array.isArray(a.forbids) ? a.forbids : [], takes = Array.isArray(a.takes) ? a.takes : [];
    const placed = a.at_mm !== undefined || a.radius_mm !== undefined;
    if (a.allows !== undefined) {
      if (!isObj(a.allows) || !Object.keys(a.allows).length) err(`${p}.allows`, 'a table of posture to where, never empty');
      else for (const [k, w] of Object.entries(a.allows)) {
        if (!REST_POSTURES.includes(k)) err(`${p}.allows.${k}`, `a posture, one of ${REST_POSTURES.join(', ')}`);
        else if (!REST_WHERE.includes(w)) err(`${p}.allows.${k}`, `where, one of ${REST_WHERE.join(', ')}`);
      }
    }
    if (a.forbids !== undefined) {
      if (!Array.isArray(a.forbids) || !a.forbids.length || !a.forbids.every(k => REST_POSTURES.includes(k)) || new Set(a.forbids).size !== a.forbids.length) err(`${p}.forbids`, `one or more different postures of ${REST_POSTURES.join(', ')}`);
      else for (const k of forbids) {
        if (k in allows) err(`${p}.forbids`, `"${k}" is both admitted and forbidden`);
        if (slotList.some(s => s.admits === 'body' && s.posture === k)) err(`${p}.forbids`, `"${k}" is forbidden, but a slot of this kind seats a body in that posture`);
      }
    }
    if (a.takes !== undefined && !(Array.isArray(a.takes) && a.takes.length && a.takes.every(k => typeof k === 'string' && KIND.test(k)))) err(`${p}.takes`, 'one or more kinds, "namespace:name": what may be set down on it');
    if (placed) {
      vec(a.at_mm, `${p}.at_mm`, err);
      if (Array.isArray(a.at_mm) && a.at_mm.some(v => isInt(v) && Math.abs(v) > AREA_REACH_MM)) err(`${p}.at_mm`, `within ${AREA_REACH_MM} mm of the thing, in its own frame`);
      if (!(isInt(a.radius_mm) && a.radius_mm > 0 && a.radius_mm <= AREA_REACH_MM)) err(`${p}.radius_mm`, `a place has a radius, whole millimetres from 1 to ${AREA_REACH_MM}`);
    }
    if (!placed && !Object.keys(allows).length && !forbids.length && !takes.length) { err(p, 'an area says something: allows, forbids, takes, or a place (at_mm and radius_mm)'); continue; }
    // Repeating what the slots say adds nothing: no place, no forbid, and every posture and kind already a slot's.
    const restRepeats = Object.entries(allows).every(([k, w]) => w === 'on' && slotList.some(s => s.admits === 'body' && s.posture === k));
    const takesRepeat = takes.every(k => slotList.some(s => s.admits === 'thing' && (!s.kinds || s.kinds.includes(k))));
    if (!placed && !forbids.length && restRepeats && takesRepeat) err(p, 'only repeats what the slots of this kind already say; leave the area out');
  }
}

function speed(v, path, err) {
  if (!(isInt(v.speed_mm_s) && v.speed_mm_s > 0)) err(`${path}.speed_mm_s`, 'its speed in whole millimetres per second, above zero');
  if (!VEHICLE_GROUNDS.includes(v.ground)) err(`${path}.ground`, `the ground it may cross, one of ${VEHICLE_GROUNDS.join(', ')}`);
}

/** A vehicle: a thing a Soul sits in or on and steers. Whoever holds the drive seat steers; the engine owns the motion. */
function vehicle(entry, err) {
  const v = entry.vehicle, slots = isObj(entry.slots) ? entry.slots : {}, forms = isObj(entry.forms) ? entry.forms : {};
  if (!isObj(v)) { err('vehicle', 'an object: {"drive", "steer", "speed_mm_s", "ground"}'); return; }
  only(v, ['drive', 'steer', 'speed_mm_s', 'ground'], 'vehicle', err);
  if (entry.owner !== 'thing') err('owner', 'a vehicle is a thing');
  if (!Array.isArray(entry.geometry?.bounds_mm)) err('geometry.bounds_mm', 'a vehicle says its size: the bounds');
  speed(v, 'vehicle', err);
  const d = slots[v.drive];
  if (!(typeof v.drive === 'string' && isObj(d) && d.admits === 'body' && d.posture === 'sit' && d.most === 1)) err('vehicle.drive', 'names a slot of this kind that admits one body, sitting: the drive seat');
  const f = forms[v.steer];
  if (!(typeof v.steer === 'string' && isObj(f))) err('vehicle.steer', 'names the form of this kind that steers it');
  else {
    if (f.who !== 'holder') err('vehicle.steer', 'the steering form is for the holder of the drive seat: who is "holder"');
    if (!(Array.isArray(f.steps) && f.steps.some(s => s?.step === 'move'))) err('vehicle.steer', 'the steering form has a move step (its motion is the engine\'s)');
  }
}

/** A ride: a set trip between stops, as a ride on a track (Engine v2 N12). Nobody steers; it may go across and back. */
function ride(entry, err) {
  const r = entry.ride, slots = isObj(entry.slots) ? entry.slots : {}, points = isObj(entry.points) ? entry.points : {}, forms = isObj(entry.forms) ? entry.forms : {};
  if (!isObj(r)) { err('ride', 'an object: {"seats", "stops", "returns", "start", "speed_mm_s", "ground"}'); return; }
  only(r, ['seats', 'stops', 'returns', 'start', 'speed_mm_s', 'ground'], 'ride', err);
  if (entry.owner !== 'thing') err('owner', 'a ride is a thing');
  if (!Array.isArray(entry.geometry?.bounds_mm)) err('geometry.bounds_mm', 'a ride says its size: the bounds');
  speed(r, 'ride', err);
  if (!Array.isArray(r.seats) || !r.seats.length) err('ride.seats', 'a list of slots that admit a body');
  else r.seats.forEach((n, i) => { if (!(slots[n]?.admits === 'body')) err(`ride.seats.${i}`, 'names a slot of this kind that admits a body'); });
  if (!Array.isArray(r.stops) || r.stops.length < 2) err('ride.stops', 'two or more stand points, in the order of the trip');
  else r.stops.forEach((n, i) => { if (points[n]?.role !== 'stand') err(`ride.stops.${i}`, 'names a point of this kind whose role is stand'); });
  if (typeof r.returns !== 'boolean') err('ride.returns', 'true if the trip goes back the way it came, false if it ends at the last stop');
  const f = forms[r.start];
  if (!(typeof r.start === 'string' && isObj(f) && f.starts === 'act')) err('ride.start', 'names the form of this kind that an actor starts the trip with');
}

/** A rider stepping off a vehicle or a ride at `spot` (one of SPOTS), `moving` or not. Getting on and off is only while it
 *  stands still, and only where the rider could stand or swim. Refused with a code, `moving` or `no_footing`, and a reason naming the spot. */
export function dismount(entry, {moving, spot}) {
  if (!isObj(entry?.vehicle) && !isObj(entry?.ride)) return {ok: false, code: 'not_a_vehicle', reason: `${entry?.kind} is neither a vehicle nor a ride`};
  if (!SPOTS.includes(spot)) return {ok: false, code: 'unknown_spot', reason: `"${spot}" is not one of ${SPOTS.join(', ')}`};
  if (moving) return {ok: false, code: 'moving', reason: `${entry.kind} is moving; getting off is only while it stands still`};
  if (!SPOTS_STAND.includes(spot) && !SPOTS_SWIM.includes(spot)) return {ok: false, code: 'no_footing', reason: `a rider could not stand or swim at ${spot}`};
  return {ok: true};
}

/** A row of places: the slots that name one `row` are ordered by `place`; a row of two or more names its ends. */
function rows(slots, err) {
  const by = {};
  for (const [name, s] of Object.entries(slots)) {
    if (!isObj(s)) continue;
    const p = `slots.${name}`;
    if (s.row === undefined) { for (const k of ['place', 'end']) if (s[k] !== undefined) err(`${p}.${k}`, 'only a slot in a row has one; name its row'); continue; }
    if (!(typeof s.row === 'string' && IDENT.test(s.row))) { err(`${p}.row`, 'a row is named in lower_snake_case'); continue; }
    if (!(isInt(s.place) && s.place > 0)) err(`${p}.place`, 'where it is in its row, counting from 1 at the first end, a whole number above zero');
    if (s.end !== undefined && !ROW_ENDS.includes(s.end)) err(`${p}.end`, `must be one of ${ROW_ENDS.join(', ')}`);
    (by[s.row] ??= []).push([name, s]);
  }
  for (const [row, list] of Object.entries(by)) {
    const nums = list.map(([, s]) => s.place).filter(isInt);
    for (const [name, s] of list) if (isInt(s.place) && nums.indexOf(s.place) !== nums.lastIndexOf(s.place)) err(`slots.${name}.place`, `place ${s.place} is used twice in row "${row}"`);
    if (list.length < 2) continue;
    const lo = Math.min(...nums), hi = Math.max(...nums);
    for (const [name, s] of list) {
      const want = s.place === lo ? 'first' : s.place === hi ? 'last' : undefined;
      if (s.end !== want) err(`slots.${name}.end`, want ? `the ${want === 'first' ? 'lowest' : 'highest'} place of row "${row}" names its end: "${want}"` : `a place in the middle of row "${row}" names no end`);
    }
  }
}

/** Points and slots lie in the thing's own frame, within the margin of its bounds (a stand point within a body's reach). */
function places(entry, points, slots, err) {
  const b = entry.geometry?.bounds_mm;
  const named = [...Object.entries(points).map(([n, v]) => [`points.${n}`, v.at_mm, v.role === 'stand' ? STAND_MARGIN_MM : POINT_MARGIN_MM]),
    ...Object.entries(slots).map(([n, v]) => [`slots.${n}`, v?.at_mm, POINT_MARGIN_MM])];
  if (!Array.isArray(b) || b.length !== 3 || !b.every(isInt)) {
    if (Object.values(points).some(v => isObj(v) && v.role !== 'stand') || Object.keys(slots).length) err('geometry.bounds_mm', 'a point or a slot is declared; say the bounds it lies within');
    return;
  }
  const lo = [-(b[0] >> 1), 0, -(b[2] >> 1)], hi = [b[0] >> 1, b[1], b[2] >> 1];
  for (const [path, at, margin] of named) {
    if (!Array.isArray(at) || at.length !== 3 || !at.every(isInt)) continue;
    const axis = at.findIndex((v, i) => v < lo[i] - margin || v > hi[i] + margin);
    if (axis >= 0) err(`${path}.at_mm`, `${'xyz'[axis]} = ${at[axis]} mm is more than ${margin} mm outside the thing's bounds (${lo[axis]} to ${hi[axis]} mm on ${'xyz'[axis]}, in its own frame)`);
  }
}

/** Does this slot of the entry admit a thing of this kind? A slot that names no kinds admits any thing; a body's slot none. */
export function admits(entry, slotName, kind) {
  const s = entry?.slots?.[slotName];
  if (!isObj(s)) return {ok: false, reason: `no slot "${slotName}"`};
  if (s.admits !== 'thing') return {ok: false, reason: `slot "${slotName}" admits a body, not a thing`};
  if (s.kinds && !s.kinds.includes(kind)) return {ok: false, reason: `slot "${slotName}" admits ${s.kinds.join(', ')}; ${kind} is not one of them`};
  return {ok: true};
}

/** The rows of an entry: for each row, its slots in order and its two ends (null while a row has a single place). */
export function rowsOf(entry) {
  const out = {};
  for (const [name, s] of Object.entries(entry?.slots ?? {})) if (isObj(s) && typeof s.row === 'string') (out[s.row] ??= []).push([s.place, name]);
  return Object.fromEntries(Object.entries(out).map(([row, l]) => { const slots = l.sort((a, b) => a[0] - b[0]).map(x => x[1]); return [row, {slots, first: slots[0], last: slots.length > 1 ? slots.at(-1) : null}]; }));
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

/** A schedule field: a declared bound and a default list of entries (the hours a copy starts with). Set whole by its owner. */
function scheduleField(f, path, err) {
  only(f, ['n', 'type', 'default', 'audience', 'most'], path, err);
  if (!(isInt(f.most) && f.most > 0 && f.most <= LIST_MOST)) err(`${path}.most`, `the most entries it ever holds, a whole number from 1 to ${LIST_MOST}`);
  if (!Array.isArray(f.default)) { err(`${path}.default`, 'a list of entries (empty if none)'); return; }
  if (isInt(f.most) && f.default.length > f.most) err(`${path}.default`, `${f.default.length} entries; the most is ${f.most}`);
  f.default.forEach((e, i) => scheduleEntry(e, `${path}.default.${i}`, err));
}

function scheduleEntry(e, path, err) {
  if (!isObj(e)) { err(path, 'an entry is an object'); return; }
  if (!SCHEDULE_REPEATS.includes(e.repeat)) { err(`${path}.repeat`, `must be one of ${SCHEDULE_REPEATS.join(', ')}`); return; }
  const weekly = e.repeat === 'weekly';
  only(e, weekly ? ['repeat', 'days', 'from_us', 'to_us'] : ['repeat', 'from_us', 'to_us'], path, err);
  const top = weekly ? DAY_US : Number.MAX_SAFE_INTEGER;
  if (!(isInt(e.from_us) && e.from_us >= 0 && e.from_us < top)) err(`${path}.from_us`, weekly ? 'local time of day in whole microseconds, from 0 up to a day' : 'a world time in whole microseconds');
  else if (!(isInt(e.to_us) && e.to_us > e.from_us && e.to_us <= top)) err(`${path}.to_us`, weekly ? 'local time of day in whole microseconds, after from_us and at most a day (an evening that runs past midnight is two entries)' : 'a world time in whole microseconds, after from_us');
  if (weekly && !(Array.isArray(e.days) && e.days.length > 0 && e.days.every(d => WEEKDAYS.includes(d)) && new Set(e.days).size === e.days.length)) err(`${path}.days`, `one to seven different days of ${WEEKDAYS.join(', ')}`);
}

/** What a kind's state costs at its declared bounds: whole values counted with every list at its maximum. The check
 *  gate measures a kind here, never at the empty default (SA-F6a, #2846). */
export function stateAtMax(entry) {
  let values = 0, listValues = 0;
  for (const f of Object.values(entry.state ?? {})) {
    if (f.type === 'list') { const n = f.most * Object.keys(f.of ?? {}).length; values += n; listValues += n; }
    else if (f.type === 'schedule') { values += f.most * 3; listValues += f.most * 3; }
    else values += 1;
  }
  return {values, listValues, children: Object.values(entry.children ?? {}).reduce((a, c) => a + c.most, 0)};
}

function vec(v, path, err, positive = false) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(x => isInt(x) && (!positive || x > 0))) err(path, `three whole numbers of millimetres${positive ? ' above zero' : ''}`);
}

/** `min` / `max`: whole bounds of an `int` field (or a timed value); an amount moved never takes it past them (SA-F2b). */
function bounds(f, path, err) {
  for (const k of ['min', 'max']) {
    if (f[k] === undefined) continue;
    if (f.type !== 'int' && f.type !== 'timed') err(`${path}.${k}`, 'only an int or a timed value has bounds');
    else if (!isInt(f[k])) err(`${path}.${k}`, 'a whole number in the field\'s unit');
  }
  if (isInt(f.min) && isInt(f.max) && f.min > f.max) err(`${path}.min`, `min ${f.min} is above max ${f.max}`);
}

/** An activity's roles (SA-G1a): each role is one of the kind's link types to a body or a Soul, with how much it is needed
 *  and where its members may be: the activity's own body slots (`this`), or body slots near it (`here`, within_mm). */
function roles(entry, err) {
  const table = section(entry, 'roles', err), links = isObj(entry.links) ? entry.links : {}, slots = isObj(entry.slots) ? entry.slots : {};
  for (const [name, r] of Object.entries(table)) {
    const p = `roles.${name}`;
    if (!(isObj(links[name]) && (links[name].from === 'body' || links[name].from === 'soul'))) err(p, 'a role is a link type of this kind whose from end is a body or a Soul');
    if (!isObj(r)) { err(p, 'a role is an object: {"need", "places"}'); continue; }
    only(r, ['need', 'places'], p, err);
    if (!ROLE_NEEDS.includes(r.need)) err(`${p}.need`, `one of ${ROLE_NEEDS.join(', ')}`);
    const pl = r.places, pp = `${p}.places`;
    if (!isObj(pl)) { err(pp, 'an object: {"in", ...}'); continue; }
    if (!PLACES_IN.includes(pl.in)) { err(`${pp}.in`, `one of ${PLACES_IN.join(', ')}`); continue; }
    if (pl.in === 'this') {
      only(pl, ['in', 'slots', 'posture'], pp, err);
      if (!(Array.isArray(pl.slots) && pl.slots.length)) err(`${pp}.slots`, 'a list of this kind\'s own slots, never empty');
      else pl.slots.forEach((n, i) => { if (slots[n]?.admits !== 'body') err(`${pp}.slots.${i}`, 'names a slot of this kind that admits a body'); });
    } else {
      only(pl, ['in', 'within_mm', 'posture'], pp, err);
      if (!(isInt(pl.within_mm) && pl.within_mm > 0)) err(`${pp}.within_mm`, 'how near the activity, whole millimetres above zero');
    }
    if (pl.posture !== undefined && !POSTURES.includes(pl.posture)) err(`${pp}.posture`, `one of ${POSTURES.join(', ')}`);
  }
}

function field(f, path, links, err, taken = false) {
  if (!isObj(f)) { err(path, 'a field is an object'); return; }
  if (f.type !== 'list' && f.type !== 'schedule') only(f, ['n', 'type', 'default', 'audience', 'values', 'unit', 'min', 'max'], path, err);
  bounds(f, path, err);
  if (taken) { if (f.audience !== undefined) err(`${path}.audience`, 'this field takes the container\'s audience (closed); it declares none of its own'); }
  else audience(f, path, links, err);
  if (ID_TYPES.has(f.type)) { err(`${path}.type`, `"${f.type}" would put an id inside a field; a relation is a link (links section)`); return; }
  if (!FIELD_TYPES.includes(f.type)) { err(`${path}.type`, `must be one of ${FIELD_TYPES.join(', ')}`); return; }
  if (f.type === 'list') { listField(f, path, err); return; }
  if (f.type === 'schedule') { scheduleField(f, path, err); return; }
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
  if (f.type === 'timed') {
    if (!UNITS.includes(f.unit)) err(`${path}.unit`, `a whole-number unit (${UNITS.join(', ')}); the rate is in that unit per second`);
    if (!isObj(d)) err(`${path}.default`, `an object: {${TIMED_KEYS.join(', ')}}`);
    else {
      only(d, TIMED_KEYS, `${path}.default`, err);
      for (const k of TIMED_KEYS) if (!isInt(d[k]) || (k === 'set_us' && d[k] < 0)) err(`${path}.default.${k}`, k === 'set_us' ? 'the world time it was set, whole microseconds' : 'a whole number');
    }
  }
  if (f.type === 'duration' && !(isInt(d) && d >= 0)) err(`${path}.default`, 'whole microseconds');
  if (f.type === 'text' && d !== null) err(`${path}.default`, 'null; inline words in state are refused, a text field holds a reference once written');
  if (f.type !== 'enum' && f.values !== undefined) err(`${path}.values`, 'only an enum has values');
  if (f.type !== 'int' && f.type !== 'timed' && f.unit !== undefined) err(`${path}.unit`, 'only an int or a timed value has a unit');
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
    else if (!(typeof v === 'string' && (v in ctx.points || v in ctx.slots || isObj(ctx.areas[v]) && 'at_mm' in ctx.areas[v]))) err(p, 'names a point, slot or placed area of this kind, or an argument');
  };
  const slot = (v, p) => { if (isArg(v)) arg(v, p, ['slot']); else if (!(v in ctx.slots)) err(p, 'names a slot of this kind, or an argument'); };
  const fieldName = (v, p) => { if (!(typeof v === 'string' && v in ctx.state)) err(p, 'names a state field of this kind'); };
  const linkName = (v, p) => { if (!(typeof v === 'string' && v in ctx.links)) err(p, 'names a link type of this kind'); };
  const value = (fname, v, p) => {
    const fd = ctx.state[fname];
    if (fd?.type === 'schedule') { err(p, 'a schedule is set whole by its owner and read by clients; a form does not write one'); return; }
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
      only(n, ['need', 'field', 'is', 'not', 'at_least', 'at_most'], p, err);
      fieldName(n.field, `${p}.field`);
      const ranged = 'at_least' in n || 'at_most' in n, exact = 'is' in n, negated = 'not' in n;
      if (ranged) {
        if (exact || negated) err(p, 'a range (at_least, at_most) or one of is, not; not both');
        const fd = ctx.state[n.field];
        if (fd && fd.type !== 'int' && fd.type !== 'duration' && fd.type !== 'timed') err(`${p}.field`, 'a range needs an int or duration field, or a timed value');
        for (const k of ['at_least', 'at_most']) if (k in n && !isInt(n[k])) err(`${p}.${k}`, 'a whole number');
        if (isInt(n.at_least) && isInt(n.at_most) && n.at_least > n.at_most) err(p, 'at_least is above at_most; nothing is in that range');
      } else if (exact === negated) err(p, 'exactly one of is, not, or a range (at_least, at_most)');
      else value(n.field, exact ? n.is : n.not, `${p}.${exact ? 'is' : 'not'}`);
    } else if (n.need === 'slot_free') { only(n, ['need', 'slot'], p, err); slot(n.slot, `${p}.slot`); }
    else if (n.need === 'within_reach') { only(n, ['need', 'point'], p, err); place(n.point, `${p}.point`); }
    else if (n.need === 'held_by_actor') only(n, ['need'], p, err);
    else if (n.need === 'hand') {
      only(n, ['need', 'free', 'holds'], p, err);
      if (('free' in n) === ('holds' in n)) err(p, 'exactly one of free, holds');
      else if ('free' in n) { if (n.free !== true) err(`${p}.free`, 'true (a hand that must hold something is "holds")'); }
      else if (!(typeof n.holds === 'string' && KIND.test(n.holds))) err(`${p}.holds`, 'a kind, "namespace:name"');
    } else if (n.need === 'room') {
      only(n, ['need'], p, err);
      if (!(Array.isArray(f.effects) && f.effects.some(e => e?.change === 'transfer'))) err(p, 'room is that every amount the form\'s transfers move has room where it lands; this form has no transfer');
    } else { only(n, ['need', 'link'], p, err); linkName(n.link, `${p}.link`); }
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
    else if (s.step === 'settle') { only(s, ['step', 'posture'], p, err); if (!POSTURES.includes(s.posture)) err(`${p}.posture`, `a ground posture taken where the body stands, one of ${POSTURES.join(', ')}`); }
    else if (s.step === 'wait') { only(s, ['step', 'us'], p, err); if (!(isInt(s.us) && s.us > 0)) err(`${p}.us`, 'a pause of a stated length, whole microseconds above zero; never a wait for a time or a condition'); }
    else only(s, ['step'], p, err);
  });
  list(f.effects, `${path}.effects`, 'change', CHANGES, err, (e, p) => {
    if (e.change === 'draw') { draw(e, p, ctx, value, fieldName, err); return; }
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
    else if (e.change === 'transfer') {
      only(e, ['change', 'field', 'from', 'into', 'amount', 'event'], p, err);
      if (ctx.state[e.field]?.type !== 'int') err(`${p}.field`, 'names an int state field of this kind; both ends move that field');
      for (const k of ['from', 'into']) { if (isArg(e[k])) arg(e[k], `${p}.${k}`, ['thing']); else if (e[k] !== 'this') err(`${p}.${k}`, '"this", or a thing argument'); }
      if (isArg(e.amount)) arg(e.amount, `${p}.amount`, ['count']);
      else if (e.amount === 'room') { if (e.into === 'this' && ctx.state[e.field]?.type === 'int' && !isInt(ctx.state[e.field].max)) err(`${p}.amount`, `"room" fills to the field's max; "${e.field}" has none`); }
      else if (!(isInt(e.amount) && e.amount > 0)) err(`${p}.amount`, 'a whole number above zero, a count argument, or "room"');
    } else if (e.change === 'timer') {
      only(e, ['change', 'form', 'after_us', 'event'], p, err);
      if (ctx.forms[e.form]?.starts !== 'timer') err(`${p}.form`, 'names a form of this kind that a timer starts');
      if (!(isInt(e.after_us) && e.after_us > 0)) err(`${p}.after_us`, 'whole microseconds above zero');
    }
  });
}

/** A draw: a table of outcomes, each a name, a weight (a whole number, or one int field of this kind), an event and the
 *  fields it sets. The world draws a whole number below the total and passes it in as data (SA-F13). */
function draw(e, p, ctx, value, fieldName, err) {
  only(e, ['change', 'outcomes'], p, err);
  if (!(Array.isArray(e.outcomes) && e.outcomes.length)) { err(`${p}.outcomes`, 'a list of outcomes, never empty'); return; }
  const names = new Set();
  e.outcomes.forEach((o, i) => {
    const op = `${p}.outcomes.${i}`;
    if (!isObj(o)) { err(op, 'an outcome is an object: {"name", "weight", "event", "set"}'); return; }
    only(o, ['name', 'weight', 'event', 'set'], op, err);
    if (!(typeof o.name === 'string' && IDENT.test(o.name))) err(`${op}.name`, 'lower_snake_case');
    else if (names.has(o.name)) err(`${op}.name`, `"${o.name}" is already an outcome of this draw`);
    else names.add(o.name);
    if (isObj(o.weight)) { only(o.weight, ['field'], `${op}.weight`, err); if (ctx.state[o.weight.field]?.type !== 'int') err(`${op}.weight.field`, 'names an int state field of this kind'); }
    else if (!(isInt(o.weight) && o.weight >= 0)) err(`${op}.weight`, 'a whole number from 0, or {"field": <an int field of this kind>}');
    if (typeof o.event !== 'string' || !IDENT.test(o.event)) err(`${op}.event`, 'every outcome names its event, lower_snake_case');
    if (!Array.isArray(o.set)) { err(`${op}.set`, 'a list of {"field", "to"} (empty if none)'); return; }
    o.set.forEach((s, j) => {
      const sp = `${op}.set.${j}`;
      if (!isObj(s)) { err(sp, 'an object: {"field", "to"}'); return; }
      only(s, ['field', 'to'], sp, err);
      fieldName(s.field, `${sp}.field`);
      if (!('to' in s)) err(`${sp}.to`, 'required'); else value(s.field, s.to, `${sp}.to`);
    });
  });
}

function list(arr, path, tag, kinds, err, each) {
  if (!Array.isArray(arr)) { err(path, 'a list (empty if none)'); return; }
  arr.forEach((x, i) => {
    const p = `${path}.${i}`;
    if (!isObj(x)) err(p, 'an object');
    else if (!kinds.includes(x[tag])) err(`${p}.${tag}`, path.startsWith('forms.') && WHEN_NAME.test(x[tag]) ? `${WHEN_REASON} ("${x[tag]}" is not a ${tag})` : `"${x[tag]}" is not in the closed list (${kinds.join(', ')}); the task that needs a new one adds it`);
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
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if ((k === 'kind' || k === 'holds') && typeof x === 'string' && KIND.test(x)) refs.add(x); else walk(x); }
  };
  walk(entry.forms);
  for (const c of Object.values(entry.stock ?? {})) if (isObj(c) && typeof c.kind === 'string') refs.add(c.kind);
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
