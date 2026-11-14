import { test } from "node:test";
import assert from "node:assert/strict";
import { eyesJob, findPlaywright, parseShootArgs, poseLooking, resolveName } from "./render.mjs";

const where = {
  souls: [{ id: "s_a", entityId: "e_ada", name: "Ada", p: [10, 0, 5], yaw: 0 }, { id: "s_b", entityId: "e_bo", name: "Bo Lin", p: [20, 0, 25], yaw: Math.PI / 2 }],
  places: [{ name: "Bandstand", p: [0, 8, 0], target: [5, 1, 5] }],
  things: [{ id: "eden-balloon", p: [40, 3, 40] }],
};

test("shoot arguments: kinds, defaults and refusals", () => {
  assert.equal(parseShootArgs([]).kind, "page");
  assert.equal(parseShootArgs([]).out, "page.png");
  assert.deepEqual(parseShootArgs(["--at", "1,2,3", "--look", "4,5,6"]).kind, "free");
  const c = parseShootArgs(["follow", "Ada", "--clip", "5", "--out", "ada.mp4", "--size", "640x360"]);
  assert.deepEqual([c.kind, c.subject, c.clip, c.out, c.size], ["follow", "Ada", 5, "ada.mp4", [640, 360]]);
  assert.throws(() => parseShootArgs(["eyes"]), /needs a Soul/);
  assert.throws(() => parseShootArgs(["free", "--at", "1,2,3"]), /--look/);
  assert.throws(() => parseShootArgs(["broadcast", "--from", "Ada"]), /free camera/);
  assert.throws(() => parseShootArgs(["--clip", "5", "--out", "x.png"]), /mp4/);
  assert.throws(() => parseShootArgs(["--out", "x.gif"]), /png or .jpg/);
  assert.throws(() => parseShootArgs(["--clip", "90"]), /1 to 30/);
  assert.throws(() => parseShootArgs(["--wat"]), /Unknown shoot option/);
});

test("names resolve to a Soul, then a place, then a thing", () => {
  assert.equal(resolveName(where, "ada").kind, "soul");
  assert.equal(resolveName(where, "band").kind, "place");
  assert.equal(resolveName(where, "eden-balloon").kind, "thing");
  assert.equal(resolveName(where, "nobody"), null);
});

test("eyes jobs: another Soul's eyes hide only that Soul; map and free show every Soul", () => {
  const e = eyesJob(parseShootArgs(["eyes", "bo"]), where);
  assert.deepEqual([e.mode, e.self, e.show, e.pose.p], ["eyes", "e_bo", ["e_ada"], [20, 1.6, 25]]);
  const m = eyesJob(parseShootArgs(["map"]), where);
  assert.deepEqual([m.mode, m.show.length, m.pose.p], ["map", 2, [15, 0, 15]]);
  assert.equal(m.span, 18);   // the Souls' 20 m spread + 16 m, halved
  const f = eyesJob(parseShootArgs(["free", "--from", "Bandstand"]), where);
  assert.deepEqual(f.pose.p, [0, 8, 0]);
  assert.ok(f.pose.pitch < 0);
  assert.throws(() => eyesJob(parseShootArgs(["free", "--from", "Atlantis"]), where), /No Soul, place or thing/);
});

test("a pose looks where it is told (engine yaw 0 faces +x)", () => {
  const p = poseLooking([0, 0, 0], [0, 0, 10], 1280, 720);
  assert.ok(Math.abs(p.yaw - Math.PI / 2) < 1e-9);
  assert.equal(p.pitch, 0);
});

test("no Playwright anywhere is null, not a throw", () => {
  assert.equal(findPlaywright(["/nonexistent-root-for-test"]), null);
});
