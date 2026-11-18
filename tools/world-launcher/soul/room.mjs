// SA-C5: the brief a mind reads at the start of a turn, composed on this machine from the client's copy (catalog and live picture)
// and its own plan. One read: what holds me and my plan's step; my own room spelled out (things by kind, with counts); one card
// per place going outward, nearest first; counts beyond; and what changed since the last read. Facts the copy holds, never labels
// an engine computed. Nothing is sent. Every other answer ends with `changed`, the same line (`changesOf`).
//
// Edit this file, then run `node tools/world-launcher/soul/inline.mjs`: worlds serve eden.mjs as one file.

/** The size the brief keeps to, as printed (indented JSON). Outward cards go first when it is tight, then the room's purposes; kinds and counts never. */
export const ROOM_BRIEF_BYTES = 1900;
export const OUTWARD_MAX = 8;
export const CHANGES_MAX = 6;
const size = (v) => Buffer.byteLength(JSON.stringify(v, null, 1));
const dist = (a, b) => (a && b ? Math.round(Math.hypot(a[0] - b[0], a[1] - b[1])) : null);
const short = (v) => { const s = v === undefined ? "unset" : JSON.stringify(v); return s.length > 40 ? `${s.slice(0, 37)}...` : s; };

/** What the copy says of me and my room, small enough to keep from one read to the next. `plan`: {id, state, step, of} or null. */
export function snapshotOf(ix, { me, live, plan, selfId }) {
  const kinds = {}, states = {};
  for (const t of me?.place ? ix.thingsAt.get(me.place) ?? [] : []) {
    kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
    const st = live?.live?.things?.[t.id];
    if (st && Object.keys(st).length) states[t.id] = st;
  }
  const hands = me?.hands && typeof me.hands === "object" ? Object.values(me.hands).filter((v) => typeof v === "string") : [];
  const near = (live?.live?.souls ?? []).filter((x) => x.id !== selfId && me?.place && x.place === me.place).length;
  return { place: me?.place ?? null, holding: hands, plan: plan ? { id: plan.id, step: plan.step, of: plan.of, state: plan.state } : null, kinds, states, near };
}

/** What differs between two snapshots, as plain lines of fact (at most CHANGES_MAX, then how many more). */
export function changesOf(prev, now, ix) {
  if (!prev) return ["first read here: nothing to compare yet"];
  const out = [], name = (id) => ix?.place(id)?.name ?? id;
  if (prev.place !== now.place) out.push(`I moved: ${prev.place ? name(prev.place) : "nowhere"} to ${now.place ? name(now.place) : "nowhere"}`);
  else {
    for (const k of new Set([...Object.keys(prev.kinds), ...Object.keys(now.kinds)])) {
      const a = prev.kinds[k] ?? 0, b = now.kinds[k] ?? 0;
      if (a !== b) out.push(`${k} here: ${a} to ${b}`);
    }
    for (const id of new Set([...Object.keys(prev.states), ...Object.keys(now.states)])) {
      const a = prev.states[id] ?? {}, b = now.states[id] ?? {};
      for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) out.push(`${id} ${f}: ${short(a[f])} to ${short(b[f])}`);
    }
    if (prev.near !== now.near) out.push(`Souls in this place: ${prev.near} to ${now.near}`);
  }
  if (prev.holding.join() !== now.holding.join()) out.push(`holding: ${prev.holding.join(", ") || "nothing"} to ${now.holding.join(", ") || "nothing"}`);
  const pp = prev.plan, np = now.plan;
  if (JSON.stringify(pp) !== JSON.stringify(np)) out.push(!np ? "my plan has ended or been dropped" : !pp ? `a plan began: step ${np.step} of ${np.of}` : `plan: step ${pp.step} to ${np.step} of ${np.of}, ${np.state}`);
  return out.length > CHANGES_MAX ? [...out.slice(0, CHANGES_MAX), `and ${out.length - CHANGES_MAX} more`] : out;
}

/** The one-line or short-list answer to "what changed": a string when nothing did. */
export const changedLine = (lines, seconds) => (lines.length ? lines : `nothing${seconds === null || seconds === undefined ? "" : `, ${seconds} s since the last read`}`);

/** The brief. `snap` is `snapshotOf` the same inputs (so it is read once); `changed` the lines or string for the end. */
export function roomBrief(ix, { me, live, plan, snap, changed, bytes = ROOM_BRIEF_BYTES }) {
  const here = me?.place ? ix.place(me.place) : null, at = me?.at;
  const purpose = (kind) => ix.cat.cards?.[kind]?.purpose;
  const kinds = Object.entries(snap.kinds).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const roomRow = (k, n, withPurpose) => `${k} x${n}${withPurpose && purpose(k) ? `: ${String(purpose(k)).slice(0, 80)}` : ""}`;
  const skip = new Set(); for (let p = here; p; p = p.parent ? ix.places.get(p.parent) : null) skip.add(p.id);
  const places = ix.cat.places.filter((p) => !skip.has(p.id) && p.id !== me?.place).map((p) => ({ p, d: dist(at, p.at) ?? 1e9 }))
    .sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));
  const card = ({ p, d }) => `${p.name} (${p.kind}${d < 1e9 ? `, ${d} m` : ""})${p.fixed ? "" : ` ${ix.walkId(p)}`}${purpose(p.kind) ? `: ${String(purpose(p.kind)).slice(0, 80)}` : ""}`;
  const elsewhere = ix.cat.things.length - kinds.reduce((s, [, n]) => s + n, 0);
  const build = (cards, purposes) => {
    const out = {
      me: here ? `${here.name}${ix.pathOf(here.id).length > 1 ? `, in ${ix.pathOf(here.id).slice(-2, -1)[0]}` : ""}${me?.doing ? `; doing ${me.doing}` : ""}` : "not in the live picture",
      holding: snap.holding.length ? snap.holding : "nothing in my hands",
      plan: plan ? `${plan.state}, step ${plan.step} of ${plan.of}: ${plan.id ?? "?"}` : "none",
      room: kinds.map(([k, n], i) => roomRow(k, n, i >= kinds.length - purposes ? false : true)),
      outward: places.slice(0, cards).map(card),
      beyond: { places: Math.max(0, places.length - cards), thingsElsewhere: elsewhere },
      changed,
    };
    return out;
  };
  // fit: fewer cards first (down to 3), then purposes off the room's rows from the end, never a kind or a count
  let cards = Math.min(OUTWARD_MAX, places.length), purposes = 0, out = build(cards, purposes);
  while (size(out) > bytes && cards > 3) out = build(--cards, purposes);
  const rows = kinds.length;
  purposes = 0;
  while (size(out) > bytes && purposes < rows) out = build(cards, ++purposes);
  while (size(out) > bytes && cards > 0) out = build(--cards, purposes);
  return out;
}

/** SA-C9: the nearest building (or house) a place is in, or the place itself: what "this house" means from this copy. */
const houseOf = (ix, id) => { for (let p = ix.place(id ?? ""), n = 0; p && n < 12; p = p.parent ? ix.places.get(p.parent) : null, n++) if (p.kind === "building" || p.kind === "house") return p.id; return id; };

/** The things of a kind in this room or house, from the copy: nearest first, at most `max`, with how many were left out. */
export function eachOf(ix, me, { each, in: where = "room", max }) {
  if (!me?.place) return { error: "this copy does not say where I am: no room to list from" };
  const scope = ix.within(where === "house" ? houseOf(ix, me.place) : me.place), name = (k) => String(k).split(":").pop();
  const all = ix.cat.things.filter((t) => scope.has(t.place) && (t.kind === each || name(t.kind) === each)).map((t) => ({ t, d: dist(me.at, t.at) ?? 1e9 }))
    .sort((a, b) => a.d - b.d || (a.t.id < b.t.id ? -1 : 1)).map((x) => x.t);
  return { things: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** Plan steps with each repeated step replaced by one step per thing it finds (`each` on a step says which). Nothing is sent. */
export function expandEach(ix, me, steps, limit = 24) {
  const out = [], note = [];
  for (const s of steps) {
    if (!s.each) { out.push(s); continue; }
    const r = eachOf(ix, me, s);
    if (r.error) return r;
    if (!r.things.length) return { error: `this copy lists no ${s.each} in this ${s.in}: nothing was sent` };
    const entry = ix.cat.entries?.[r.things[0].kind];
    if (entry && !entry.forms?.[s.form]) return { error: `${s.each} has no form "${s.form}": its forms are ${Object.keys(entry.forms ?? {}).join(", ") || "none"}` };
    r.things.forEach((t, i) => out.push({ id: `object:${t.id}:${s.form}`, ...(s.params ? { params: s.params } : {}), each: { kind: s.each, n: i + 1, of: r.things.length } }));
    note.push({ kind: s.each, in: s.in, steps: r.things.length, ...(r.more ? { left_out: r.more, why: `max ${s.max}` } : {}) });
  }
  if (out.length > limit) return { error: `that makes ${out.length} steps; a plan has at most ${limit}` };
  return { steps: out, each: note };
}
