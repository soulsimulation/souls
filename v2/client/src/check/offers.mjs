// A thing's own offers, read from its kind entry on this machine (0.131 parity C16, #3686): today's `inspect <id>`
// and `object <id> [action]`. Nothing here asks the world: the thing's row comes from the daemon's copy and its kind's
// entry from `<home>/kinds/` (`state.mjs`'s `kindsIn`).
//
// An offer is one act word the thin command's `act` takes (`daemon.mjs` `actsOf`), named by what it does:
//   walk     every thing: walk to it (`<id>` alone, or `walk:<id>`)
//   sit, lie a thing whose kind has a slot of that posture and no form of that name (the world picks the free slot)
//   <form>   each of the kind's forms, with `who` may start it and the parameters it `takes` (their schema as the
//            entry writes it: `field`/`value` with `of`, `thing`, `slot`, `part`, `count`, `duration`, `text`, ...).
//            A parameter with a `select` is chosen by the world when it is left out.
//   steer, stop, land   a thing that moves on a course (a punt, #3603) with seats for bodies: the engine's own verbs
//            `carrier:steer`, `carrier:stop` and `carrier:land` for a rider seated in it. steer takes the point to row
//            toward, `x=<m> z=<m>` in the world's metres; land rows home, and a point given must be by its home.
// Each carries `act`, its word for `act`, and `usage`, the whole command with each parameter as `<name>=<...>`.

import { find } from '../find/find.mjs';

/** Verbs that are the world's own moves when sent with no form arguments (`daemon.mjs` `MOVES`). */
const MOVE_NAMES = new Set(['walk', 'sit', 'lie', 'rise']);

/** The entry's body slots, those of posture `form` first when it names one. */
function slotNames(entry, form) {
  const all = Object.entries(entry?.slots ?? {}).filter(([, s]) => s?.admits === 'body' || s?.posture);
  const of = all.filter(([, s]) => s?.posture === form);
  return (of.length ? of : all).map(([n]) => n);
}

/** A parameter's placeholder in `usage`: its choices when the entry lists them, else its type. */
const placeholder = (t) => (Array.isArray(t?.of) ? t.of.join('|') : t?.type === 'thing' ? 'id' : String(t?.type ?? 'value'));

/** The most a repeated move goes on, s (`skills::form_runner::FOR_MOST_S`): a step defaulting to it is held. */
const FOR_MOST_S = 3600;

/** How long an offer whose move repeats lasts, in words, from its step's `for_s` default and the argument `n` it takes. */
function lastsOf(n, def, moves = 1) {
  if (def === undefined) return `once; ${n}=<seconds> keeps it up, unbroken, that long`;
  if (def >= FOR_MOST_S) return `unbroken until your next act or \`stop\` (an hour at most); ${n}=<seconds> for a set time`;
  return moves > 1 ? `${def} s for each of its ${moves} moves, back to back, unless ${n}=<seconds>` : `${def} s, unbroken, unless ${n}=<seconds>`;
}

/** The engine's verbs for a rider of a thing on a course (#3603), as `act`'s words: `carrier:<verb>:<id>`. */
export const CARRIER_VERBS = Object.freeze(['steer', 'stop', 'land']);
const METRES = { type: 'metres' };

/** A rider's offers on thing `id` that moves on a course: steer, stop and land. */
function carrierOffers(id) {
  const of = (name, params, usage) => ({ name, act: `carrier:${name}:${id}`, who: 'rider', ...(params ? { params } : {}), usage: ['act', `carrier:${name}:${id}`, ...usage].join(' ') });
  return [
    of('steer', { x: METRES, z: METRES }, ['x=<m>', 'z=<m>']),
    of('stop', null, []),
    of('land', { x: { ...METRES, optional: true }, z: { ...METRES, optional: true } }, ['[x=<m> z=<m>]']),
  ];
}

/**
 * The offers of thing `id` from kind entry `entry` (absent when none is held). `moving`: the copy holds a course on
 * it, so a body seated in it may steer it (#3603).
 */
export function offersOf(id, entry, { moving = false } = {}) {
  const out = [{ name: 'walk', act: `walk:${id}`, usage: `act ${id}` }];
  const forms = entry?.forms ?? {};
  for (const posture of ['sit', 'lie']) {
    const slots = Object.entries(entry?.slots ?? {}).filter(([, s]) => s?.posture === posture).map(([n]) => n);
    if (slots.length && !forms[posture]) out.push({ name: posture, act: `${posture}:${id}`, slots, usage: `act ${posture}:${id}` });
  }
  for (const [name, f] of Object.entries(forms)) {
    const takes = f?.takes ?? {};
    // A form named as a move (`sit` on a picnic table) is that form only when it is given its arguments; bare, the
    // word is the move, which does not walk there first. So its slot is not left to the world: the first is named.
    const moveNamed = MOVE_NAMES.has(name);
    let lasts = null;
    const params = Object.fromEntries(Object.entries(takes).map(([n, t]) => {
      const slots = t?.type === 'slot' && !Array.isArray(t.of) ? slotNames(entry, name) : null;
      const p = { ...t, ...(slots?.length ? { of: slots } : {}) };
      // 0.135: a repeated move's length (`for_s: {"arg": n, "default": s}`, a dance's `for`), whole seconds. Left out,
      // the step's default: an hour is held until the next act or `stop`; none is the move done once.
      const repeats = (f?.steps ?? []).filter((st) => st?.for_s?.arg === n), repeat = repeats[0]?.for_s;
      if (repeat) { p.type = 'seconds'; lasts ??= lastsOf(n, repeat.default, repeats.length); }
      if (moveNamed && slots?.length) p.default = slots[0];
      else if (repeat) p.optional = true;
      else if (t?.select) p.optional = true;
      return [n, p];
    }));
    const words = Object.entries(params).map(([n, t]) => (t.optional || t.default !== undefined ? `[${n}=<${placeholder(t)}>]` : `${n}=<${placeholder(t)}>`));
    out.push({ name, act: `${name}:${id}`, form: name, who: f?.who ?? 'anyone', ...(Object.keys(params).length ? { params } : {}), usage: ['act', `${name}:${id}`, ...words].join(' '), ...(lasts ? { lasts } : {}) });
  }
  if (moving && slotNames(entry, 'sit').length) out.push(...carrierOffers(id));
  return out;
}

/** The offer's words for `act`: given arguments, then each parameter's `default` the arguments leave out. */
export function actWords(offer, args = []) {
  const named = new Set(args.map((a) => String(a).split('=')[0]));
  const filled = Object.entries(offer.params ?? {}).filter(([n, p]) => p.default !== undefined && !named.has(n)).map(([n, p]) => `${n}=${p.default}`);
  return [offer.act, ...args.map(String), ...filled];
}

/** Edit distance, for naming the offers or ids nearest a word that names none. */
function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = was;
    }
  }
  return d[b.length];
}

/** The offer `action` names: its name, its act word (`brush:<id>`), or a namespaced verb (`eden:brush`); or null. */
export function offerNamed(offers, action) {
  const a = String(action ?? '');
  const byAct = offers.find((o) => o.act === a);
  if (byAct) return byAct;
  const name = a.includes(':') ? (offers.some((o) => o.act === a) ? a.slice(0, a.lastIndexOf(':')) : a.slice(a.indexOf(':') + 1)) : a;
  return offers.find((o) => o.name === name) ?? null;
}

/** Up to three offer names nearest `action`, nearest first; every name when the thing has few. */
export function nearestOffers(offers, action) {
  const a = String(action ?? '').replace(/^[^:]*:/, '').toLowerCase();
  const ranked = offers.map((o) => ({ name: o.name, d: o.name.startsWith(a) || a.startsWith(o.name) ? 0 : distance(a, o.name) }));
  ranked.sort((x, y) => x.d - y.d || x.name.localeCompare(y.name));
  const near = ranked.filter((r) => r.d <= Math.max(2, Math.floor(a.length / 3)));
  return (near.length ? near : ranked).slice(0, 3).map((r) => r.name);
}

/** Up to three ids of rows nearest `id`: the search's best for it as words, else the ids nearest it by spelling. */
export function nearestIds(rows, id) {
  const all = [...rows];
  const found = find(all, String(id ?? ''), { limit: 3 }).found ?? [];
  if (found.length) return found.map((f) => ({ id: f.id, name: f.name }));
  const s = String(id ?? '');
  return all.map((r) => ({ r, d: distance(s, r.id) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map(({ r }) => ({ id: r.id, name: r.name }));
}
