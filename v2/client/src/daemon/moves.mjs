// `can` on a move (Engine v2 C14, #3442): a walk, a sit, a lie or a rise is checked with replica's `move_check`, the
// function the world runs before it starts a move, on what this client knows: whether its copy holds the target, and
// whether its body is in a seat, as its own moves' receipts last said (unknown until one has). A seat's holds are not
// in the copy, so a sit on a free-looking seat stays `unknown`; unknown never blocks a send (R8).

/** The move form of a verb (`<ns>:walk|sit|lie|rise`, any namespace but the engine's own), or null. */
export function moveForm(verb) {
  const m = /^([^:\s]+):(walk|sit|lie|rise)$/.exec(String(verb ?? ''));
  return m && m[1] !== 'souls' ? m[2] : null;
}

/** The verdict on move intent `{verb, this?, point?}`: `check` is the WASM build's `move_check`. */
export function moveVerdict(check, intent, { nodes, seated }) {
  const has = intent.this != null && nodes?.[intent.this] != null;
  const input = { verb: intent.verb, has, ...(intent.this != null ? { this: String(intent.this) } : {}) };
  if (Array.isArray(intent.point)) input.point = intent.point;
  if (typeof seated === 'boolean') input.seated = seated;
  return JSON.parse(check(JSON.stringify(input)));
}

/** Whether the body is in a seat after its move `form` was answered with `answer` (1 a receipt): else as it was. */
export function seatedAfter(form, answer, seated) {
  if (answer !== 1 || !form) return seated;
  return form === 'sit' || form === 'lie';
}
