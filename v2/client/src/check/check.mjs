// Checking an act locally and at send time (Engine v2 R8, #2703). A model thinks for seconds and the copy moves
// meanwhile, so the daemon checks a candidate on its own copy when asked (`can`) and again at the moment of sending
// (`act`), with R2's form rules (`rules_decide`, the same function the world runs, in replica's WASM build).
//
// - **A verdict** is R2's: `yes`; `no` with the need, reason, detail and fix; or `unknown`. A `no` is a local one
//   only for a reason the copy holds the data for (`seen`); any other `no`, and a `bad_input` (this client's own
//   input, not the world's state), counts as `unknown`.
// - **Current.** A local refusal is given only while the copy is current: its age under `CURRENT_MS` and no gap
//   (R10's `age`). Otherwise the candidate is sent and the world decides.
// - **Unknown never blocks.** At send time a candidate is dropped only on a current, definite `no`. Dropping one is
//   the client following the agent's own ranked list; it never adds one. If none is left, nothing is sent.
// - A candidate is `{verb, this, form, args}`: `verb` is what is sent; `this`, `form` and `args` say which form on
//   which thing it means. A bare verb names no form and is never checked.

/** The declared bound: a copy confirmed current longer ago than this is not used to refuse. */
export const CURRENT_MS = 1000;

/** The reasons whose data a copy of fields, links and slots holds. Reach and hands need the body's pose and hands. */
export const SEEN_ALL = new Set(['field_differs', 'slot_taken', 'not_linked', 'already_linked', 'no_room']);
/** What the daemon's copy holds today: fields only (`state.mjs`). */
export const SEEN_FIELDS = new Set(['field_differs']);

/** Whether a copy of this age may refuse locally. */
export function isCurrent(age, bound = CURRENT_MS) {
  return !age.gap && !age.stale && typeof age.age === 'number' && age.age <= bound;
}

/** A candidate as given: a verb, or `{verb, this, form, args}`. Throws by name on anything else. */
export function candidateOf(c) {
  if (typeof c === 'string') return { verb: c };
  if (!c || typeof c !== 'object' || typeof c.verb !== 'string') {
    throw Object.assign(new Error('a candidate is a verb or {verb, this, form, args}'), { code: 'act-candidate' });
  }
  const out = { verb: c.verb };
  if (c.this != null && c.form != null) Object.assign(out, { this: String(c.this), form: String(c.form), ...(c.args ? { args: c.args } : {}) });
  return out;
}

/**
 * The verdict on one candidate: R2's `decide` (a function from JSON text to JSON text) over `{kinds, act, state,
 * asker}`, reduced to what a client may act on: `{verdict, reason?, need?, detail?, fix?, node?, field?}`.
 */
export function judge(decide, c, { kinds, state, asker, seen = SEEN_FIELDS }) {
  if (!c.form) return { verdict: 'unknown', why: 'no-form' };
  const node = state.nodes?.[c.this];
  if (!node) return { verdict: 'unknown', why: 'not-in-copy' };
  if (!kinds[node.entry] && !kinds[node.kind]) return { verdict: 'unknown', why: 'kind-not-held' };
  const act = { this: c.this, form: c.form, ...(c.args ? { args: c.args } : {}) };
  const v = JSON.parse(decide(JSON.stringify({ kinds, act, state, asker })));
  delete v.read;
  if (v.verdict === 'no' && (v.reason === 'bad_input' || !seen.has(v.reason))) return { verdict: 'unknown', why: `not-seen:${v.reason}` };
  return v;
}

/** `can`'s answer: the verdict and whether the copy was current enough to refuse with it. */
export function canOf({ verdict, ...rest }, current) {
  return { can: verdict, ...rest, current };
}

/**
 * At send time: the candidates left after dropping each one with a current, definite `no`, in their order, and the
 * dropped ones with their reasons. `verdicts[k]` is candidate k's.
 */
export function sift(candidates, verdicts, current) {
  const keep = [], dropped = [];
  candidates.forEach((c, k) => {
    const v = verdicts[k];
    if (current && v?.verdict === 'no') dropped.push({ verb: c.verb, this: c.this, form: c.form, reason: v.reason, detail: v.detail, fix: v.fix ?? null });
    else keep.push(c);
  });
  return { keep, dropped };
}
