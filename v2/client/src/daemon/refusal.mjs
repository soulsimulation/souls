// A refusal as an agent reads it: the world's own words for why (an answer's detail, field 8, which the WASM `wireFrame`
// puts last on its line), and the next step after a refusal that names an activity or a body an activity holds. Pure:
// the daemon hands in the copy's rows and the events it logged.

const ID = /^[0-9a-f]{32}-\d+$/;

/** A `wireFrame` line split as the daemon reads it: its seven fields, then the refusal's detail (with its spaces). */
export function answerParts(line) {
  const [kind, a, b, c, d, names = '-', op = '-', ...said] = String(line).split(' ');
  return { kind, a, b, c, d, names, op, detail: kind === 'answer' ? said.join(' ') : '' };
}

/** A refusal's detail as a person reads it: µm in metres, and each body or thing it names (the world's short form,
 *  `<first scope byte>:<counter>`) by its name and id in the copy, when one row there is it. `rows`: the copy's rows. */
export function readableDetail(text, rows) {
  const all = [...rows];
  return String(text).slice(0, 400)
    .replace(/(\d+) µm/g, (_, n) => `${(Number(n) / 1e6).toFixed(2)} m`)
    .replace(/\b([0-9a-f]{2}):(\d+)\b/g, (short, b, n) => {
      const hit = all.filter((r) => r.id.startsWith(b) && r.id.endsWith(`-${n}`));
      return hit.length === 1 ? `${hit[0].name || 'it'} (${hit[0].id})` : short;
    });
}

/**
 * The next step after refused act `r` (its receipt: `verbs`, `target`, `answers`) when it is an activity's to give:
 * held by an activity (`resource-blocked`), leave it first, never another offer that is refused too; an activity's
 * own verb refused `together.too-far`, walk up to the thing it is played at or to the Soul who offered it (never to
 * the activity's node), and any other refusal of one has none (null). `undefined`: not an activity's, for the offers.
 * `rows`: the copy's rows by id; `logged`: the events this daemon kept.
 */
export function activityTry(r, { rows, logged }) {
  const target = String(r.target ?? '').split(' ')[0], reason = r.answers.at(-1)?.reason;
  if (reason === 'resource-blocked') {
    const held = logged.findLast((x) => (x.kind === 'together' || x.kind === 'carry') && ID.test(String(x.offer ?? '')));
    return { command: held ? `together leave ${held.offer}` : 'find activity', why: 'this body is held by an activity: `together leave <its id or word>` first (`find activity` lists them)' };
  }
  if (!r.verbs.some((v) => String(v).startsWith('activity:'))) return undefined;
  if (reason !== 'together.too-far') return null;
  const parent = rows.get(target)?.parent;
  const at = parent && !/(^|:)ground$/.test(String(rows.get(parent)?.kind ?? '').split('@')[0]) ? parent : null;
  const to = at ?? logged.findLast((x) => x.offer === target && ID.test(String(x.from ?? '')))?.from;
  return to ? { act: `walk:${to}`, name: 'walk', checked: 'unknown', why: at ? 'walk to the thing it is played at, then accept again' : 'walk up to the Soul who offered it, then accept again' } : null;
}
