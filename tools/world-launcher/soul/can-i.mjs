// SA-C3: "Can I?" answered on this machine. The rules are the world's own (packages/form-rules `decide`), run on the copy of the
// world the client already keeps: a thing's kind entry (`catalog.entries`, by kind, in the entry format), its fields from the live
// picture, and this Soul's body where the world publishes it. Nothing is sent. A need whose inputs this copy does not hold is
// "unknown" and never blocks a send; a definite "no" from another need wins over it. After a refusal that carries the world's own
// verdict (`decided`), the copy is made to say what the world reported. The client reads facts only: no label is computed here.
import { decide } from "../../../packages/form-rules/src/rules.ts";
import { soulWalk } from "./catalog.mjs";

/** Needs that read this Soul's body (hands, effector) rather than the thing. */
const BODY = new Set(["hand", "held_by_actor", "within_reach"]);

/** `object:<thing>:<form>`: the act id a form of a thing is sent as. */
export const parseOffer = (id) => { const m = /^object:([^:]+):([^:]+)$/.exec(String(id ?? "")); return m ? { thing: m[1], form: m[2] } : null; };

const show = (v) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));
const wantedText = (w = {}) => [
  "is" in w ? `to be ${show(w.is)}` : null, "not" in w ? `to be anything but ${show(w.not)}` : null,
  "at_least" in w ? `at least ${w.at_least}` : null, "at_most" in w ? `at most ${w.at_most}` : null].filter(Boolean).join(" and ");

/** What a refusal's verdict says is missing, in plain words with the facts under them. */
export function missingOf(v) {
  const d = v.detail ?? {};
  if (v.reason === "field_differs") return { reason: v.reason, field: d.field, found: d.found, wanted: d.wanted, text: `${d.field} is ${show(d.found)}; this needs it ${wantedText(d.wanted)}` };
  if (v.reason === "out_of_reach") return { reason: v.reason, point: d.point, text: `the ${d.point} is out of reach from where you stand` };
  return { reason: v.reason, detail: d, text: String(v.reason).replace(/_/g, " ") };
}

/** The next act a verdict's fix names, from data only. */
export function nextOf(ix, thing, v) {
  const f = v.fix;
  if (f?.form) return { act: `object:${thing.id}:${f.form}`, ...(f.args && Object.keys(f.args).length ? { params: f.args } : {}) };
  if (f?.step === "walk_to") return soulWalk(ix, thing) ?? { step: f };
  if (f?.step) return { step: f };
  return v.detail?.field ? { find: v.detail.field } : null;
}

const ageOf = (copy, now) => (Number.isFinite(copy?.receivedAt) ? Math.max(0, Math.round((now - copy.receivedAt) / 1000)) : null);

/** Can this Soul do `form` of `thing` now, as far as this copy can tell. `copy` is the live copy on disk, `me` this Soul's row. */
export function canI(ix, thingId, formName, { args = {}, copy, me = null, now = Date.now() } = {}) {
  const thing = ix.things.get(thingId);
  if (!thing) return { error: `No thing with id "${thingId}" in the catalog.` };
  const entry = ix.cat.entries?.[thing.kind];
  if (!entry) return { thing: thingId, form: formName, can: "unknown", why: `this copy holds no entry for ${thing.kind}: ask the world (act, or inspect ${thingId})` };
  const form = entry.forms?.[formName];
  if (!form) return { thing: thingId, form: formName, can: "unknown", why: `${thing.kind} has no form "${formName}"`, forms: Object.keys(entry.forms ?? {}).filter((k) => entry.forms[k].starts === "act") };
  const age_s = ageOf(copy, now), out = { thing: thingId, form: formName };
  if (!copy?.live) return { ...out, can: "unknown", why: "no live picture yet: the thing's state is not known here", age_s: null };
  const needs = Array.isArray(form.needs) ? form.needs : [], moves = ix.cat.moves ?? {};
  const body = { hands: me?.hands, effector_mm: me?.effector_mm };
  const holds = (n) => {
    if (n?.need === "state") return true;
    if (n?.need === "hand" || n?.need === "held_by_actor") return !!body.hands && typeof body.hands === "object";
    if (n?.need === "within_reach") return Array.isArray(body.effector_mm) && Object.keys(moves).length > 0;
    return false;
  };
  const kept = [], index = [], skipped = [];
  needs.forEach((n, i) => { if (holds(n)) { kept.push(n); index.push(i); } else skipped.push({ need: i, kind: n?.need ?? null, ...(BODY.has(n?.need) ? { because: "this copy has no body reading" } : { because: "this copy does not hold it" }) }); });
  const v = decide({
    kinds: { [thing.kind]: { ...entry, forms: { ...entry.forms, [formName]: { ...form, needs: kept } } } },
    act: { this: thingId, form: formName, args },
    state: { actor: "me", nodes: { [thingId]: { kind: thing.kind, fields: copy.live.things?.[thingId] ?? {} }, me: { hands: body.hands, effector_mm: body.effector_mm } }, moves },
    asker: { sees: ["public"] },
  });
  const rest = { age_s, ...(skipped.length ? { not_checked: skipped } : {}) };
  if (v.verdict === "no" && v.reason !== "bad_input") {
    const missing = missingOf(v), next = nextOf(ix, thing, v);
    return { ...out, can: "no", need: index[v.need] ?? v.need, missing, ...(next ? { next } : {}), ...rest };
  }
  if (v.verdict === "no") return { ...out, can: "unknown", why: `the copy cannot judge it: ${v.detail?.what ?? "bad input"}`, ...rest };
  if (v.verdict === "unknown" || skipped.length) return { ...out, can: "unknown", why: v.verdict === "unknown" ? `${v.field ?? v.link} is not visible to this Soul` : "some needs read what this copy does not hold", ...rest };
  return { ...out, can: "yes", ...rest };
}

/** Every form of a thing that starts as an act, each answered in a line. */
export function canAll(ix, thingId, opts) {
  const thing = ix.things.get(thingId), entry = thing && ix.cat.entries?.[thing.kind];
  if (!entry) return canI(ix, thingId, "", opts);
  const forms = Object.keys(entry.forms ?? {}).filter((k) => entry.forms[k].starts === "act");
  return { thing: thingId, kind: thing.kind, forms: forms.map((f) => { const r = canI(ix, thingId, f, opts); return { form: f, can: r.can, ...(r.missing ? { missing: r.missing.text } : r.why ? { why: r.why } : {}), ...(r.next ? { next: r.next } : {}) }; }), age_s: ageOf(opts?.copy, opts?.now ?? Date.now()) };
}

/** The world refused with its own verdict (`decided`, the library's, as the world computed it). Make the copy say what the world
 *  read: each `<node>/field/<n>` in its `read` is a field the world holds at that value. Returns the copy and what differed. */
export function syncRefusal(copy, ix, decided) {
  const changed = [];
  if (!copy?.live || !Array.isArray(decided?.read)) return { copy, changed };
  const things = { ...(copy.live.things ?? {}) };
  for (const [addr, value] of decided.read) {
    const m = /^(.+)\/field\/(\d+)$/.exec(String(addr));
    const thing = m && ix.things.get(m[1]), entry = thing && ix.cat.entries?.[thing.kind];
    const field = entry && Object.keys(entry.state ?? {}).find((k) => entry.state[k].n === Number(m[2]));
    if (!field) continue;
    const was = Object.hasOwn(things[thing.id] ?? {}, field) ? things[thing.id][field] : entry.state[field].default;
    if (JSON.stringify(was) === JSON.stringify(value)) continue;
    things[thing.id] = { ...things[thing.id], [field]: value };
    changed.push({ thing: thing.id, field, was, now: value });
  }
  return { copy: changed.length ? { ...copy, live: { ...copy.live, things } } : copy, changed };
}
