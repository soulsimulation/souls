// The matcher (Engine v2 R9, #2728): one pattern language for everything in the Soul's client that turns a change in
// its copy into an action with no model turn. R9's reflexes use it now; R13's wake rules and R15's schedule entries
// that fire on a change add their own actions on top of it. It runs only in the client: nothing here reaches the
// world, and the world never runs a Soul.
//
// An event is one of T6's named events (v2/docs/effects.md rule 4) with what its entry's envelope says, as the
// daemon reads it from a frame:
//   { name: 'souls:offer', fields: { 1: ..., 2: ... }, actor: 's_...' | null, toMe: true | false, sequence: n }
// `actor` is the Soul who caused it (null for the world or a creator); `toMe`, whether it is addressed to this Soul.
//
// A pattern (`when`):
//   { "event": "<namespace:name>" | ["<name>", ...],   the event's name, exactly
//     "from": ["<soul id>", ...],                      optional: only events these Souls caused
//     "toMe": true,                                     optional: only events addressed to this Soul
//     "fields": { "<field number>": <value>, ... } }    optional: these fields hold exactly these values
//
// T6's names are not a closed list: a later build may write a name this one has never seen (rule 8). So a name is
// checked for its form and matched exactly; a name no event carries never matches, and is not refused.

const NAME = /^[a-z0-9_-]+:[a-z0-9_./@-]+$/;
const SOUL = /^s_[A-Za-z0-9_-]+$/;
const FIELD = /^\d{1,4}$/;
const KEYS = new Set(['event', 'from', 'toMe', 'fields']);

/** A refusal, by name. */
export class Refused extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const scalar = (v) => typeof v === 'string' || Number.isSafeInteger(v);

/** Checks a pattern and gives it back in one form: `{ event: [names], from?, toMe?, fields? }`. Refuses by name. */
export function parseWhen(when) {
  if (!when || typeof when !== 'object' || Array.isArray(when)) throw new Refused('when-not-a-pattern', 'when is an object');
  for (const k of Object.keys(when)) if (!KEYS.has(k)) throw new Refused('when-unknown-key', k);
  const event = Array.isArray(when.event) ? when.event : [when.event];
  if (event.length === 0 || !event.every((n) => typeof n === 'string' && NAME.test(n))) {
    throw new Refused('when-event-not-a-name', 'event is a namespace:name, or a list of them');
  }
  const out = { event };
  if ('from' in when) {
    if (!Array.isArray(when.from) || when.from.length === 0 || !when.from.every((s) => typeof s === 'string' && SOUL.test(s))) {
      throw new Refused('when-from-not-souls', 'from is a list of Soul ids');
    }
    out.from = [...when.from];
  }
  if ('toMe' in when) {
    if (when.toMe !== true) throw new Refused('when-tome-not-true', 'toMe is true or left out');
    out.toMe = true;
  }
  if ('fields' in when) {
    const f = when.fields;
    if (!f || typeof f !== 'object' || Array.isArray(f) || !Object.entries(f).every(([k, v]) => FIELD.test(k) && scalar(v))) {
      throw new Refused('when-fields-not-values', 'fields maps field numbers to a text or an integer');
    }
    out.fields = { ...f };
  }
  return out;
}

/**
 * Whether `event` matches the parsed pattern `p`, for the Soul `self`. An event this Soul caused never matches: a
 * rule must not fire on what its own intent did.
 */
export function matches(p, event, self) {
  if (event.actor === self) return false;
  if (!p.event.includes(event.name)) return false;
  if (p.from && !p.from.includes(event.actor)) return false;
  if (p.toMe && event.toMe !== true) return false;
  if (p.fields) for (const [k, v] of Object.entries(p.fields)) if (event.fields?.[k] !== v) return false;
  return true;
}
