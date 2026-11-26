// A bare word given to `act` (`act rise`, `act exercise`): the one act the Soul's world offers by that word, read from
// the copy's rows and the kinds held on this machine (`offers.mjs`), never a list kept here. `daemon.mjs` `actsOf`
// asks this only for a word its own body's forms do not name. A word that names several acts, or none, is refused
// with the choices or the nearest offers named; the world is asked nothing.

import { actWords, nearestOffers, offersOf } from './offers.mjs';

/** The world's own moves that take no thing (`daemon.mjs` `MOVES`): sent as `<ns>:<move>` as they are. */
const UNTARGETED = new Set(['rise']);
/** A bare word: a verb's plain name, no namespace, no id. */
export const BARE = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** The most choices a refusal names. */
const CHOICES_MOST = 6;

const refusal = (code, detail, extra) => Object.assign(new Error(detail), { code, ...extra });

/**
 * Word `w` as act words to send in its place (`{ words }`), or as an untargeted move (`{ verb }`); throws a refusal by
 * name (`act-word-ambiguous` with `choices`, `act-word-unknown` with `did_you_mean`). `rows` are the copy's rows by
 * id, `kinds` the held entries by kind, `me` this Soul's body row (or null), `ns` the world's namespace.
 */
export function bareAct(w, { rows, kinds, me, ns }) {
  const word = String(w), snake = word.replace(/-/g, '_');
  if (UNTARGETED.has(snake)) return { verb: `${ns}:${snake}` };
  const mine = me ? kinds[me.entry ?? me.kind] : null;
  const found = [], names = new Set([...UNTARGETED, ...Object.keys(mine?.forms ?? {})]);
  for (const r of rows.values()) {
    // Another Soul's body is not a thing to act on by a bare word (a dance on their body is theirs to start).
    if (r === me || r.soul !== undefined || (me && r.kind === me.kind)) continue;
    const entry = kinds[r.entry ?? r.kind];
    if (!entry) continue;
    for (const o of offersOf(r.id, entry, { moving: Boolean(r.moving) })) {
      names.add(o.name);
      if (o.name === snake || o.name === word) found.push({ offer: o, row: r });
    }
  }
  if (found.length === 1) return { words: actWords(found[0].offer) };
  if (found.length > 1) {
    found.sort((a, b) => a.row.name.localeCompare(b.row.name, 'en', { numeric: true }));
    const choices = found.slice(0, CHOICES_MOST).map(({ offer, row }) => ({ act: offer.act, name: row.name }));
    const list = choices.map((c) => `${c.act} (${c.name})`).join(', ');
    throw refusal('act-word-ambiguous', `${word}: ${found.length} things here offer it; name one: act ${list}`, { choices });
  }
  // The body or its kind is not on this machine yet (a first act before the copy or the kinds came): the body's act
  // by that word, which the world judges.
  if (!mine) return { verb: `${ns}:${snake}`, ...(me ? { this: me.id } : {}) };
  const near = nearestOffers([...names].map((name) => ({ name })), snake);
  throw refusal('act-word-unknown', `nothing here offers ${word}; nearest: ${near.join(', ')} (inspect <id> lists a thing's offers)`, { did_you_mean: near });
}
