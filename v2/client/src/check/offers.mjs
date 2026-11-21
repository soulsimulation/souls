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
// Each carries `act`, its word for `act`, and `usage`, the whole command with each parameter as `<name>=<...>`.

import { find } from '../find/find.mjs';

/** A parameter's placeholder in `usage`: its choices when the entry lists them, else its type. */
const placeholder = (t) => (Array.isArray(t?.of) ? t.of.join('|') : t?.type === 'thing' ? 'id' : String(t?.type ?? 'value'));

/** The offers of thing `id`, whose copy row is `row`, from kind entry `entry` (absent when none is held). */
export function offersOf(id, entry) {
  const out = [{ name: 'walk', act: `walk:${id}`, usage: `act ${id}` }];
  const forms = entry?.forms ?? {};
  for (const posture of ['sit', 'lie']) {
    const slots = Object.entries(entry?.slots ?? {}).filter(([, s]) => s?.posture === posture).map(([n]) => n);
    if (slots.length && !forms[posture]) out.push({ name: posture, act: `${posture}:${id}`, slots, usage: `act ${posture}:${id}` });
  }
  for (const [name, f] of Object.entries(forms)) {
    const takes = f?.takes ?? {};
    const params = Object.fromEntries(Object.entries(takes).map(([n, t]) => [n, { ...t, ...(t?.select ? { optional: true } : {}) }]));
    const words = Object.entries(params).map(([n, t]) => (t.optional ? `[${n}=<${placeholder(t)}>]` : `${n}=<${placeholder(t)}>`));
    out.push({ name, act: `${name}:${id}`, form: name, who: f?.who ?? 'anyone', ...(Object.keys(params).length ? { params } : {}), usage: ['act', `${name}:${id}`, ...words].join(' ') });
  }
  return out;
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
