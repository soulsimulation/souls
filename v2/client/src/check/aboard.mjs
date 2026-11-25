// First-day round 4 (25 Nov): a Soul aboard a thing on a course (a balloon) is told the truth about it. Right after
// boarding the balloon stands at its stop for the rest of its boarding window, so the answer says when it takes off;
// while it is away, a refusal says when it is back at its stop, where `rise` gets off. Worked out from the copy alone:
// the thing's course (replica `schedule::F_COURSE`, field 80) read by the replica's own `courseAt`, the formula the
// world moves it by, so nothing is asked of the world.

/** How far ahead it looks for a take-off or a return to the stop, world µs: a balloon's lap is a few minutes. */
export const LOOK_US = 30 * 60_000_000;
const STEP_US = 1_000_000;
/** How near its stop a still thing counts as standing there, µm (its stop is a station: it stands exactly on it). */
const AT_STOP_UM = 500_000;

/** T0's deterministic CBOR of a decoded course value (`brief/copy.mjs` `decode`): the bytes `courseAt` reads. */
export function encodeCourse(v) {
  const out = [];
  const head = (major, n) => {
    const b = BigInt(n);
    if (b < 24n) out.push((major << 5) | Number(b));
    else if (b < 0x100n) out.push((major << 5) | 24, Number(b));
    else if (b < 0x10000n) out.push((major << 5) | 25, ...bytes(b, 2));
    else if (b < 0x100000000n) out.push((major << 5) | 26, ...bytes(b, 4));
    else out.push((major << 5) | 27, ...bytes(b, 8));
  };
  const bytes = (b, n) => Array.from({ length: n }, (_, k) => Number((b >> BigInt(8 * (n - 1 - k))) & 255n));
  const item = (x) => {
    if (typeof x === 'number' || typeof x === 'bigint') { const b = BigInt(x); if (b >= 0n) head(0, b); else head(1, -1n - b); }
    else if (x instanceof Uint8Array) { head(2, x.length); out.push(...x); }
    else if (typeof x === 'string') { const b = Buffer.from(x, 'utf8'); head(3, b.length); out.push(...b); }
    else if (Array.isArray(x)) { head(4, x.length); x.forEach(item); }
    else if (x instanceof Map) { const ks = [...x.keys()].sort((a, b) => Number(a) - Number(b)); head(5, ks.length); for (const k of ks) { item(k); item(x.get(k)); } }
    else if (typeof x === 'boolean' || x === null) out.push(x === null ? 0xf6 : x ? 0xf5 : 0xf4);
    else throw new Error(`encode: ${typeof x}`);
  };
  item(v);
  return Uint8Array.from(out);
}

/** The course's stop, where riders get on and off: its own loop's first station, a steered course's last (`carrier.rs`). */
function stopOf(course) {
  const stations = course instanceof Map ? course.get(1) : null;
  if (!Array.isArray(stations) || !stations.length) return null;
  const shape = Number(course.get(2));
  const s = shape === 3 ? stations.at(-1) : stations[0];
  return Array.isArray(s?.[0]) ? s[0].map(Number) : null;
}

/**
 * Where this Soul is aboard, or null: `rows` the copy's rows, `me` this Soul (its body is the row with `soul: me`),
 * `courseAt` the replica's, `now` world µs. → `{id, name, atStop, takesOffInS?, backInS?}`: at its stop, how long until
 * it leaves; away, how long until it is back at its stop (null when not within LOOK_US).
 */
export function aboardOf({ rows, me, courseAt, now }) {
  const body = [...rows.values()].find((r) => r.id === me || r.soul === me);
  const on = body?.parent ? rows.get(body.parent) : null;
  if (!on?.course || typeof courseAt !== 'function' || !Number.isFinite(now)) return null;
  let field;
  try { field = encodeCourse(on.course); } catch { return null; }
  const stop = stopOf(on.course);
  const at = (t) => { try { const v = courseAt(field, BigInt(Math.floor(t))); return { p: [0, 1, 2].map((k) => Number(v[k])), still: Number(v[3]) === 0 && Number(v[4]) === 0 && Number(v[5]) === 0 }; } catch { return null; } };
  const atStop = (s) => s?.still && stop && Math.hypot(s.p[0] - stop[0], s.p[1] - stop[1], s.p[2] - stop[2]) <= AT_STOP_UM;
  const here = at(now);
  if (!here) return null;
  const secs = (t) => Math.max(Math.ceil((t - now) / 1_000_000), 0);
  // The first time after `now` when `want` holds, to the second (a step, then halved down to a tenth of a second).
  const first = (want) => {
    for (let t = now + STEP_US; t <= now + LOOK_US; t += STEP_US) {
      if (!want(at(t))) continue;
      let lo = t - STEP_US, hi = t;
      while (hi - lo > 100_000) { const mid = Math.floor((lo + hi) / 2); if (want(at(mid))) hi = mid; else lo = mid; }
      return hi;
    }
    return null;
  };
  if (atStop(here)) {
    const leaves = first((s) => s && !s.still);
    return { id: on.id, name: on.name, atStop: true, takesOffInS: leaves === null ? null : secs(leaves) };
  }
  const back = first(atStop);
  return { id: on.id, name: on.name, atStop: false, backInS: back === null ? null : secs(back) };
}

/** What an answer says of it: on boarding (`done`) when it takes off; on a refusal, when the Soul can get off. */
export function aboardWords(a, { refused = false } = {}) {
  if (!a) return null;
  if (a.atStop) {
    const off = a.takesOffInS == null ? null : `takes off in ${a.takesOffInS} s`;
    return refused ? `aboard ${a.name}, at its stop: rise to get off${off ? ` (it ${off})` : ''}` : `aboard ${a.name}; ${off ?? 'at its stop'}`;
  }
  const back = a.backInS == null ? 'when it is back at its stop' : `at its stop in ${a.backInS} s`;
  return refused ? `aboard ${a.name}; you can get off ${back} (rise then)` : `aboard ${a.name}, under way; you can get off ${back}`;
}
