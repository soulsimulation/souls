// #1755: the client applies the world's live frames exactly as the world builds them, and hashes its copy as the world does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFrame, liveHash, resumeFrom, wholeCopy } from "./live.mjs";
import { liveDelta, liveHash as worldHash } from "../../../apps/server/src/edge/catalog/live-delta.ts";

const W = "http://world.test";
const pic = (tick, souls, extra = {}) => ({ contract: "soul-live/1", worldId: "w", scope: "public", tick, at: tick, catalog: "c1", souls, speech: [], ...extra });
const row = (id, at, place = "g-yard") => ({ id, name: id, at, place, doing: null });

test("frames from the world's differ keep a copy whose hash is the world's", () => {
  const p1 = pic(1, [row("s_a", [1, 1]), row("s_b", [2, 2])], { things: { e_1: { on: true } } });
  let copy = applyFrame(null, W, "live.full", { ...p1, epoch: "ep", seq: 1 }, 1).copy;
  assert.equal(resumeFrom(copy, W), "ep:1");
  const p2 = pic(2, [row("s_b", [3, 3], "g-hall")], { catalog: "c2", things: { e_1: { on: false }, e_2: { open: true } }, speech: [{ id: "sp1", at: 2, text: "hi" }] });
  const d = liveDelta(p1, p2, 2);
  copy = applyFrame(copy, W, "live", JSON.parse(JSON.stringify({ epoch: "ep", ...d })), 2).copy;
  assert.equal(liveHash(copy.live), worldHash(p2));
  assert.equal(copy.live.catalog, "c2"); assert.deepEqual(copy.speech.map((l) => l.id), ["sp1"]);
  assert.deepEqual(applyFrame(copy, W, "live", { epoch: "ep", seq: 2, check: worldHash(p2) }, 3).copy.receivedAt, 3, "a check that agrees keeps the copy current");
  assert.deepEqual(applyFrame(copy, W, "live", { epoch: "ep", ...d }, 4), { copy: null }, "a change already applied is not applied twice");
});

test("a copy not on the frame's seq, from another epoch, or with a hash that disagrees takes the whole picture", () => {
  const copy = wholeCopy(W, null, { ...pic(1, [row("s_a", [1, 1])]), epoch: "ep", seq: 5 }, 1);
  assert.deepEqual(applyFrame(copy, W, "live", { epoch: "ep", seq: 7, base: 6, tick: 2, at: 2 }, 2), { whole: "gap" });
  assert.deepEqual(applyFrame(copy, W, "live", { epoch: "other", seq: 6, base: 5, tick: 2, at: 2 }, 2), { whole: "epoch" });
  assert.deepEqual(applyFrame(copy, W, "live", { epoch: "ep", seq: 5, check: "0000000000000000" }, 2), { whole: "hash" });
  assert.deepEqual(applyFrame(copy, W, "live", { epoch: "ep", seq: 9, check: "0000000000000000" }, 2), { whole: "behind" });
  assert.deepEqual(applyFrame({ ...copy, world: "http://other.test" }, W, "live", { epoch: "ep", seq: 6, base: 5 }, 2), { whole: "epoch" }, "a copy of another world");
});

test("speech is kept by id: a line sent again is one line", () => {
  const line = { id: "sp1", at: 1, text: "hi" };
  let copy = wholeCopy(W, null, { ...pic(1, [], { speech: [line] }), epoch: "ep", seq: 1 }, 1);
  copy = wholeCopy(W, copy, { ...pic(2, [], { speech: [line, { id: "sp2", at: 2, text: "yo" }] }), epoch: "ep", seq: 2 }, 2);
  assert.deepEqual(copy.speech.map((l) => l.id), ["sp1", "sp2"]);
});
