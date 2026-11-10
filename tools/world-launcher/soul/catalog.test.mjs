import { test } from "node:test";
import assert from "node:assert/strict";
import { indexCatalog, find, query, placeView, bestPlace } from "./catalog.mjs";

const cat = {
  contract: "soul-catalog/1", worldId: "w-1", scope: "public", placeVerbs: ["walk"],
  places: [
    { id: "world", name: "World", kind: "region", parent: null, at: [0, 0] },
    { id: "g-village", name: "Eden Village", kind: "district", parent: "world", at: [50, 0] },
    { id: "g-library", ref: "eden-library", name: "Eden Library", kind: "building", parent: "g-village", at: [70, 0], what: "Reading tables and book-lined walls." },
    { id: "g-library.reading", ref: "eden-library/reading", name: "Reading Room", kind: "room", parent: "g-library", at: [71, 1] },
    { id: "g-annex", ref: "campus-library-annex", name: "Campus Library Annex", kind: "building", parent: "world", at: [300, 0] },
    { id: "g-pond", ref: "commons-pond", name: "Commons Pond", kind: "water", parent: "world", at: [10, 40] },
    { id: "g-mill-e", ref: "windmill-east", name: "East Windmill", kind: "landmark", parent: "world", at: [400, 0] },
    { id: "g-mill-w", ref: "windmill-west", name: "West Windmill", kind: "landmark", parent: "world", at: [-400, 0] },
    { id: "basket", name: "Balloon basket", kind: "vehicle", parent: "world", at: [0, 0], fixed: true },
  ],
  things: [
    { id: "e_b1", name: "promenade-bench-1", kind: "core-bench-seat", place: "g-pond", at: [12, 42] },
    { id: "e_b2", name: "market-bench-9", kind: "core-bench-seat", place: "g-annex", at: [300, 5] },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `e_c${i}`, name: `library/chair-${i}`, kind: "core-chair", place: "g-library.reading", at: [71 + i / 10, 1] })),
  ],
  acts: [
    { id: "read:read.e_t1", verb: "read", place: "g-library.reading", thing: "e_t1", at: [71, 1], label: "read (reading table west in Reading Room)" },
    { id: "book-club:book-club.e_t1", verb: "book-club", place: "g-library.reading", thing: "e_t1", at: [71, 1], label: "book club (reading table west in Reading Room)", with: 1 },
    { id: "eat:eat.e_d1", verb: "eat", place: "g-village", at: [52, 2], label: "eat (dining table in Eden Village)" },
    { id: "eat:eat.e_d2", verb: "eat", place: "g-annex", at: [300, 2], label: "eat (cafe table in Campus Library Annex)" },
    { id: "cook:cook.e_k1", verb: "cook", place: "g-village", at: [51, 1], label: "cook (the cooking pot in Eden Village)" },
  ],
};
const ix = indexCatalog(cat), at = [50, 0];

test("a place's own name finds the place first, with the walk to send", () => {
  const r = find(ix, "library", { at });
  assert.equal(r.found[0].type, "place");
  assert.equal(r.found[0].act, "walk:eden-library");
  assert.deepEqual(r.found[0].path, ["World", "Eden Village"]);
  assert.equal(r.found[0].metres, 20);
  assert.deepEqual(r.found[0].canDo, { read: 1, "book-club": 1 });
  assert.ok(r.found.findIndex((x) => x.id === "g-annex") > 0, "the farther library is listed after the nearer one");
});

test("two places of one name are both listed, nearest first: the agent chooses", () => {
  const r = find(ix, "windmill", { at });
  assert.deepEqual(r.found.map((x) => x.act), ["walk:windmill-east", "walk:windmill-west"]);
});

test("a verb, or words that mean one, find where it can be done, the asked verb before its neighbours", () => {
  for (const r of [find(ix, "", { verb: "eat", at }), find(ix, "somewhere to eat", { at })]) {
    assert.deepEqual(r.found.map((x) => x.id), ["eat:eat.e_d1", "eat:eat.e_d2", "cook:cook.e_k1"]);
    assert.equal(r.found[0].metres, 3);
  }
});

test('"near" and "in" read the thing and its anchor', () => {
  const near = find(ix, "bench near the pond", { at });
  assert.deepEqual(near.found.map((x) => x.id), ["e_b1"]);
  assert.equal(near.near.id, "g-pond");
  const inside = find(ix, "chair in the library", { at, limit: 3 });
  assert.equal(inside.found.length, 3);
  assert.equal(inside.more, 9);
  assert.ok(inside.found.every((x) => x.place === "g-library.reading"));
  assert.equal(find(ix, "bench", { inPlace: "nowhere-at-all", at }).note, 'No place called "nowhere-at-all" in the catalog.');
});

test("a place a Soul cannot walk to names no walk", () => {
  assert.equal(find(ix, "balloon basket", { at }).found[0].act, null);
});

test("a place view groups: twelve chairs are one line, an act alone names its id", () => {
  const v = placeView(ix, "eden-library", { depth: 2, at });
  assert.equal(v.things["core-chair"], 12);
  assert.equal(v.canDo.read, "read:read.e_t1");
  assert.deepEqual(v.parts, [{ id: "g-library.reading", name: "Reading Room", kind: "room" }]);
  assert.equal(placeView(ix, "nowhere").error, 'No place called "nowhere" in the catalog.');
});

test("several questions are answered in one call, each within its budget, and a cut says so", () => {
  const [lib, eats, bad] = query(ix, [{ place: "eden-library", verbs: ["read"] }, { verb: "eat", limit: 1 }, { nonsense: 1 }], { at });
  assert.deepEqual(Object.keys(lib.canDo), ["read"]);
  assert.equal(eats.found.length, 1);
  assert.equal(eats.more, 2);
  assert.match(bad.error, /A question is/);
  const [tight] = query(ix, [{ find: "chair in the library", limit: 12, budget: 120 }], { at });
  assert.ok(JSON.stringify(tight).length / 4 <= 200, "the answer was trimmed toward its budget");
  assert.ok(tight.cut.found > 0);
});

test("the anchor of a relation is the best-named place, nearest on a tie", () => {
  assert.equal(bestPlace(ix, "library", at).id, "g-library");
  assert.equal(bestPlace(ix, "campus-library-annex", at).id, "g-annex");
  assert.equal(bestPlace(ix, "volcano", at), null);
});
