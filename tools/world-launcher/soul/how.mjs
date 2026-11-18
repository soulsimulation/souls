// SA-C4b: a how-to is data on a kind (the entry's `howtos`: a text reference and steps naming forms of that kind). `how "<words>"`
// finds one in the entries this client holds (`catalog.entries`), puts real things of that kind in its steps (the nearest in this
// copy), says which kind is missing when the world has none, and returns the chain as a plan for the resident (`plan`). Each step
// is checked with `can` as far as this copy can tell. A form that starts a timer is a wait: the chain is cut there, and the rest
// is a wake entry of the client's own (`wake add thing-state … --plan`). Nothing is sent and the world never waits for anything.
import { canI } from "./can-i.mjs";
import { tokensOf } from "./catalog.mjs";

export const HOW_STEPS_MAX = 6;
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity);
const US = 1_000_000;

/** The how-tos of every kind this copy holds an entry for, with their words. */
export function howtosOf(ix) {
  const out = [];
  for (const [kind, entry] of Object.entries(ix.cat.entries ?? {})) {
    for (const [name, h] of Object.entries(entry?.howtos ?? {})) out.push({ kind, name, entry, steps: h.steps ?? [], text: entry.text?.[h.text] ?? "" });
  }
  return out;
}

/** The how-tos whose name or words hold every word asked, best first (a name that is the words wins). */
export function matchHowtos(ix, words) {
  const want = tokensOf(words);
  if (!want.length) return [];
  return howtosOf(ix).map((h) => {
    const have = new Set([...tokensOf(h.name), ...tokensOf(h.text)]), named = new Set(tokensOf(h.name));
    return { h, ok: want.every((w) => have.has(w)), score: want.filter((w) => named.has(w)).length * 2 + want.filter((w) => have.has(w)).length };
  }).filter((x) => x.ok).sort((a, b) => b.score - a.score || (a.h.name < b.h.name ? -1 : 1)).map((x) => x.h);
}

/** What a form's timer waits for: the field its timed form sets, when it sets one. */
function waitOf(entry, form) {
  const timer = (entry.forms?.[form]?.effects ?? []).find((e) => e.change === "timer");
  if (!timer) return null;
  const set = (entry.forms?.[timer.form]?.effects ?? []).find((e) => e.change === "set");
  return { after_s: Math.ceil((timer.after_us ?? 0) / US), ...(set ? { field: set.field, is: set.to } : {}) };
}

/** `h` for `thing` as the client's plan: steps up to and including the first wait, and what remains with the wake that continues it. */
export function planOf(ix, h, thing, { copy, me, now = Date.now() } = {}) {
  // A leading step whose every effect is a set this copy already shows is done (a kettle already filled): passed over, and said.
  const fields = copy?.live?.things?.[thing.id];
  const isDone = (s) => { const fx = h.entry.forms?.[s.form]?.effects ?? []; return !!fields && fx.length > 0 && fx.every((e) => e.change === "set" && fields[e.field] === e.to); };
  let skip = 0;
  while (skip < h.steps.length && isDone(h.steps[skip])) skip++;
  const done = h.steps.slice(0, skip).map((s) => ({ form: s.form, act: `object:${thing.id}:${s.form}`,
    why: `already so on this copy: ${(h.entry.forms[s.form].effects).map((e) => `${e.field} is ${JSON.stringify(e.to)}`).join(", ")}` }));
  const used = h.steps.slice(skip, skip + HOW_STEPS_MAX), cut = h.steps.length - skip - used.length;
  const rows = used.map((s) => {
    const form = h.entry.forms?.[s.form], c = canI(ix, thing.id, s.form, { copy, me, now });
    return { form: s.form, act: `object:${thing.id}:${s.form}`, can: c.can, ...(c.missing ? { missing: c.missing.text } : c.why ? { why: c.why } : {}), ...(c.next ? { next: c.next } : {}),
      ...(form?.takes ? { takes: Object.keys(form.takes) } : {}), wait: waitOf(h.entry, s.form) };
  });
  const at = rows.findIndex((r) => r.wait);
  const first = at < 0 ? rows : rows.slice(0, at + 1), rest = at < 0 ? [] : rows.slice(at + 1);
  const plan = first.map((r) => r.act), w = at < 0 ? null : rows[at].wait;
  const later = rest.length ? {
    waits_for: w.field ? `${thing.id} ${w.field} is ${JSON.stringify(w.is)}` : `${w.after_s} s`,
    plan: rest.map((r) => r.act),
    ...(w.field ? { wake: `wake add thing-state '${JSON.stringify({ thing: thing.id, field: w.field, is: w.is })}' --plan '${JSON.stringify(rest.map((r) => r.act))}' --end ${new Date(now + (w.after_s * 2 + 60) * 1000).toISOString()}` } : {}),
  } : null;
  return { plan, ...(done.length ? { done } : {}), steps: rows.map(({ wait, ...r }) => ({ ...r, ...(wait ? { then_waits_s: wait.after_s } : {}) })), ...(later ? { later } : {}), ...(cut > 0 ? { cut: `${cut} more step${cut === 1 ? "" : "s"} not shown: a how-to here is at most ${HOW_STEPS_MAX}` } : {}) };
}

/** `how "<words>"`: the best how-to for the words, with real things of its kind from this copy, or the kind that is missing. */
export function how(ix, words, { at, copy, me, now = Date.now() } = {}) {
  const found = matchHowtos(ix, words);
  if (!found.length) return { how: null, why: `no how-to here matches "${words}": this copy holds ${howtosOf(ix).map((h) => h.name).join(", ") || "none"}` };
  const h = found[0], things = ix.cat.things.filter((t) => t.kind === h.kind).sort((a, b) => dist(at, a.at) - dist(at, b.at) || (a.id < b.id ? -1 : 1));
  const also = found.slice(1, 4).map((x) => x.name);
  if (!things.length) return { how: h.name, text: h.text, kind: h.kind, missing: [{ kind: h.kind, why: `this world has no ${h.kind}: nothing to do it with here` }], steps: [], ...(also.length ? { also } : {}) };
  const t = things[0], p = planOf(ix, h, t, { copy, me, now });
  return { how: h.name, text: h.text, kind: h.kind, with: { thing: t.id, name: t.name, ...(Number.isFinite(dist(at, t.at)) ? { metres: Math.round(dist(at, t.at)) } : {}) }, ...p,
    next: p.steps[0]?.can === "no" ? `the first step is not possible now: ${p.steps[0].missing ?? ""}`.trim() : `plan '${JSON.stringify(p.plan)}'   (or: how "${words}" --run)`, ...(also.length ? { also } : {}) };
}
