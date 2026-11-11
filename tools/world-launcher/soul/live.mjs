// The live picture kept current by the world's push (#1755): soul-live/1 changes arrive on the event stream serve already
// holds, each on the seq before it. Pure: the same frames and the same hash as apps/server/src/edge/catalog/live-delta.ts.
import { createHash } from "node:crypto";

/** How long a copy kept by the push counts as current without a frame (the world sends its hash every 5 s). */
export const PUSHED_FRESH_MS = 8_000;
/** Lines of speech this copy keeps (the world sends its newest 40). */
export const SPEECH_KEEP = 200;

/** JSON with object keys sorted, arrays in order: the bytes the hash is taken over, on both sides. */
export function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
}
/** The world's hash of what a copy must agree on: every Soul's row, the things' states and the catalog version. */
export function liveHash(live) {
  const souls = [...(live?.souls ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash("sha256").update(canon({ catalog: live?.catalog ?? null, souls, things: live?.things ?? {} })).digest("hex").slice(0, 16);
}
const keepSpeech = (have, lines) => {
  const seen = new Map((have ?? []).map((x) => [x.id, x]));
  for (const line of lines ?? []) seen.set(line.id, line);
  return [...seen.values()].sort((a, b) => a.at - b.at).slice(-SPEECH_KEEP);
};
/** The copy as kept on disk ({world, receivedAt, live, speech}) from a whole picture (a GET or a `live.full` frame). */
export function wholeCopy(world, have, live, receivedAt) {
  const mine = have?.world === world ? have : null;
  return { world, receivedAt, live: { ...live, speech: undefined }, speech: keepSpeech(mine?.speech, live.speech) };
}
/** Where this copy resumes from (`<epoch>:<seq>`), or null when it has none from this world. */
export const resumeFrom = (copy, world) => (copy?.world === world && copy.live?.epoch && Number.isSafeInteger(copy.live.seq) ? `${copy.live.epoch}:${copy.live.seq}` : null);

/** One frame on a copy. Returns {copy} when applied (or a check that agrees), {whole: reason} when this copy needs the
 *  whole picture (a change not on its seq, another epoch, a check that disagrees), {copy: null} for nothing to do. */
export function applyFrame(copy, world, event, frame, receivedAt) {
  if (event === "live.full") return { copy: { ...wholeCopy(world, copy, frame, receivedAt), pushed: true } };
  const live = copy?.world === world ? copy.live : null;
  if (!live || live.epoch !== frame.epoch) return { whole: "epoch" };
  if (frame.check) {
    if (frame.seq !== live.seq) return frame.seq > live.seq ? { whole: "behind" } : { copy: null };
    return liveHash(live) === frame.check ? { copy: { ...copy, receivedAt, pushed: true } } : { whole: "hash" };
  }
  if (frame.seq <= live.seq) return { copy: null };   // already applied
  if (frame.base !== live.seq) return { whole: "gap" };
  const souls = new Map((live.souls ?? []).map((r) => [r.id, r]));
  for (const id of frame.souls?.del ?? []) souls.delete(id);
  for (const r of frame.souls?.set ?? []) souls.set(r.id, r);
  const next = { ...live, seq: frame.seq, tick: frame.tick, at: frame.at, souls: [...souls.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
  if (frame.catalog !== undefined) next.catalog = frame.catalog;
  if (frame.thingsMore !== undefined) next.thingsMore = frame.thingsMore;
  if (frame.things) {
    const things = { ...(live.things ?? {}) };
    for (const id of frame.things.del ?? []) delete things[id];
    Object.assign(things, frame.things.set ?? {});
    next.things = things;
  }
  return { copy: { ...copy, receivedAt, pushed: true, live: next, speech: frame.speech?.length ? keepSpeech(copy.speech, frame.speech) : copy.speech } };
}
