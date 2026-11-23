// R8b (0.133): one thing as a creator reads it, `souls-god describe <id>`, from the daemon's copy (its `describe` and
// `fields` answers) and the kinds' entries the home keeps (kinds/*.json): its kind and card, where it is (each frame up
// to the world's root, and its spot in its parent, mm), its numbered fields under the names its kind's state gives
// them, its slots and what holds each, what is in it, and its owner and access marks. Read only: nothing is sent.

/** The kind's entry the home keeps, by its plain name (`ns:name`), or null. */
const entryOf = (entries, kind) => entries[String(kind).split('@')[0]] ?? null;

/** `{ ok, id, kind, card, in: [...frames to the root], at, yaw?, slot?, fields, slots?, holds, marks?, text? }`. */
export function describeThing(id, d, fields, entries = {}) {
  const nodes = new Map(d.nodes.map((n) => [String(n.id), n]));
  const n = nodes.get(String(id));
  if (!n) return { ok: false, code: 'edit.node-missing', detail: `${id} is not in the copy` };
  const entry = entryOf(entries, n.kind);
  // each frame it is in, nearest first, to the world's root
  const frames = [];
  for (let p = n.parent, k = 0; p != null && k < 64; k++) { const f = nodes.get(String(p)); if (!f) break; frames.push({ id: f.id, kind: f.kind, ...(f.text ? { text: f.text } : {}) }); p = f.parent; }
  // fields under the names the kind's state gives their numbers; any other number stays a number
  const byN = new Map(Object.entries(entry?.state ?? {}).map(([name, s]) => [String(s?.n), name]));
  const named = Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [byN.get(String(k)) ?? k, v]));
  // its slots (the pinned kind's, by number) and what holds each; and everything in it
  const pinned = Object.entries(d.kinds ?? {}).find(([full]) => full.split('@')[0] === String(n.kind).split('@')[0])?.[1];
  const inside = d.nodes.filter((c) => String(c.parent) === String(n.id));
  const slots = pinned?.slots ? Object.fromEntries(Object.entries(pinned.slots).map(([s, def]) => [s, { ...def, holds: inside.filter((c) => String(c.slot) === s).map((c) => c.id) }])) : undefined;
  return {
    ok: true, id: n.id, kind: n.kind,
    ...(entry?.text?.card ? { card: entry.text.card } : {}),
    in: frames, ...(n.at ? { at: n.at } : {}), ...(n.yaw !== undefined ? { yaw: n.yaw } : {}), ...(n.slot !== undefined ? { slot: n.slot } : {}),
    fields: named, ...(slots ? { slots } : {}),
    holds: inside.map((c) => ({ id: c.id, kind: c.kind, ...(c.slot !== undefined ? { slot: c.slot } : {}) })),
    ...(n.marks ? { marks: n.marks } : {}), ...(n.text ? { text: n.text } : {}), ...(n.hours ? { hours: n.hours } : {}),
  };
}
