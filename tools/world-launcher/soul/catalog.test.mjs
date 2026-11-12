import { test } from "node:test";
import assert from "node:assert/strict";
import { indexCatalog, find, query, placeView, bestPlace, handActs } from "./catalog.mjs";

const cat = {
  contract: "soul-catalog/1", worldId: "w-1", scope: "public", placeVerbs: ["walk", "hang-out"],
  anywhere: [{ id: "sit-ground:here", verb: "sit-ground", label: "Sit down on the ground or floor, right here" }, { id: "wave:here", verb: "wave", label: "Wave" }, { id: "nap:here", verb: "nap", label: "Take a nap right here" }],
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
    { id: "e_b1", name: "promenade-bench-1", kind: "core-bench-seat", place: "g-pond", at: [12, 42], seat: true },
    { id: "e_gym", name: "gym-bench-press", kind: "eden-weight-bench", place: "g-annex", at: [305, 5] },
    { id: "e_tree", name: "old-oak", kind: "core-tree", place: "g-annex", at: [310, 5] },
    { id: "e_b2", name: "market-bench-9", kind: "core-bench-seat", place: "g-annex", at: [300, 5], seat: true },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `e_c${i}`, name: `library/chair-${i}`, kind: "core-chair", place: "g-library.reading", at: [71 + i / 10, 1], seat: true })),
  ],
  acts: [
    { id: "read:read.e_t1", verb: "read", place: "g-library.reading", thing: "e_t1", at: [71, 1], label: "read (reading table west in Reading Room)" },
    { id: "book-club:book-club.e_t1", verb: "book-club", place: "g-library.reading", thing: "e_t1", at: [71, 1], label: "book club (reading table west in Reading Room)", with: 1 },
    { id: "eat:eat.e_d1", verb: "eat", place: "g-village", thing: "e_d1", at: [52, 2], label: "eat (dining table in Eden Village)" },
    { id: "eat:eat.e_d1.2", verb: "eat", place: "g-village", thing: "e_d1", at: [53, 2], label: "eat (dining table in Eden Village)" },
    { id: "eat:eat.e_d1.3", verb: "eat", place: "g-village", thing: "e_d1", at: [54, 2], label: "eat (dining table in Eden Village)" },
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
    assert.deepEqual(r.found.map((x) => x.act), ["eat:eat.e_d1", "eat:eat.e_d2", "cook:cook.e_k1"]);
    assert.equal(r.found[0].metres, 3);
    assert.equal(r.found[0].places, 3, "a table's three seats are one row, its nearest seat standing for it");
    assert.equal(r.found[0].in, "Eden Village, World");
    assert.equal(r.found[1].places, undefined);
  }
});

test('"near" and "in" read the thing and its anchor', () => {
  const near = find(ix, "bench near the pond", { at });
  assert.deepEqual(near.found.map((x) => x.id), ["e_b1"]);
  assert.equal(near.found[0].act, "sit:e_b1", "a seat names its own sit");
  assert.equal(find(ix, "gym bench press", { at }).found.find((x) => x.id === "e_gym")?.act, undefined, "a bench a body does not sit on (the world says which) names no sit");
  assert.equal(near.found[0].in, "Commons Pond, World");
  assert.equal(near.near.id, "g-pond");
  const inside = find(ix, "chair in the library", { at, limit: 3 });
  assert.equal(inside.found.length, 3);
  assert.equal(inside.more, 9);
  assert.ok(inside.found.every((x) => x.place === "g-library.reading"));
  assert.equal(find(ix, "bench", { inPlace: "nowhere-at-all", at }).note, 'No place called "nowhere-at-all" in the catalog.');
});

test("what a body does on the spot is found by its words, and comes before anything a walk away", () => {
  for (const words of ["sit floor", "sit down on the floor", "sit on the ground"]) assert.equal(find(ix, words, { at }).found[0].act, "sit-ground:here", words);
  assert.equal(find(ix, "wave", { at }).found[0].act, "wave:here");
  assert.equal(find(ix, "", { verb: "sleep", at }).found[0].act, "nap:here", "a word that means a verb reaches its neighbours on the spot too");
  assert.equal(find(ix, "wave", { inPlace: "eden-library", at }).found.length, 0, "the spot is not somewhere else");
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

test("the catalog vouches for the ids it publishes and says nothing about the rest", () => {
  for (const id of ["walk:eden-library", "walk:g-library", "hang-out:commons-pond", "read:read.e_t1", "sit:e_b1", "sit-ground:here"]) assert.equal(ix.knows(id), true, id);
  for (const id of ["walk:nowhere", "walk:basket", "read:read.e_gone", "sit:e_zz", "sit:e_tree", "sit:e_gym", "dance:here", "object:e_b1:open"]) assert.equal(ix.knows(id), false, id);
});

// #1751: things worked by hand, with their state from the live picture
const handCat = { ...cat, places: [...cat.places, { id: "g-office", ref: "eden-office", name: "Eden Office", kind: "building", parent: "g-village", at: [60, 10] }, { id: "g-office.reception", name: "Reception", kind: "room", parent: "g-office", at: [61, 10] }],
  things: [...cat.things, { id: "e_l1", name: "office/desk-lamp", kind: "core-desk-lamp", place: "g-office.reception", at: [61, 11] }, { id: "e_l2", name: "office/old-lamp", kind: "core-desk-lamp", place: "g-office.reception", at: [62, 11], byHand: false },
    { id: "e_ch", name: "porch-chest", kind: "core-chest", place: "g-village", at: [55, 0] }, { id: "e_l3", name: "office/dim-lamp", kind: "core-desk-lamp", hands: "core-desk-lamp@3", place: "g-office.reception", at: [63, 11] },
    { id: "e_bd", name: "porch-board", kind: "core-chalkboard", place: "g-village", at: [56, 0] }],
  kinds: {
    "core-desk-lamp": { acts: [{ verb: "switch-on", label: "Switch on", when: [{ field: "on", is: false }] }, { verb: "switch-off", label: "Switch off", when: [{ field: "on", is: true }] }], state: { on: true } },
    "core-desk-lamp@3": { acts: [{ verb: "dim", label: "Dim", when: [{ field: "on", is: true }] }], state: { on: true } },
    "core-chalkboard": { acts: [{ verb: "write", label: "Write" }, { verb: "erase", label: "Erase", when: [{ field: "text", not: "" }] }], state: {} },
    "core-chest": { acts: [{ verb: "open", label: "Open", when: [{ field: "open", is: false }, { field: "locked", not: true }] }, { verb: "close", label: "Close", when: [{ field: "open", is: true }] }, { verb: "lock", label: "Lock", when: [{ field: "locked", is: false }, { field: "open", not: true }] }, { verb: "unlock", label: "Unlock", when: [{ field: "locked", is: true }] }], state: { open: false, locked: false } } } };
const hix = indexCatalog(handCat);

test("a lamp in a place comes with its state and the one act that state allows; the live picture changes both", () => {
  const on = find(hix, "lamp", { inPlace: "reception", at }).found.find((r) => r.id === "e_l1");
  assert.deepEqual(on.state, { on: true }); assert.equal(on.act, "object:e_l1:switch-off"); assert.equal(on.also, undefined);
  const off = find(hix, "lamp", { inPlace: "g-office.reception", at, states: { e_l1: { on: false } } }).found.find((r) => r.id === "e_l1");
  assert.deepEqual(off.state, { on: false }); assert.equal(off.act, "object:e_l1:switch-on");
  const old = find(hix, "lamp", { inPlace: "reception", at }).found.find((r) => r.id === "e_l2");
  assert.equal(old.state, undefined); assert.equal(old.act, undefined, "a revision that takes no acts offers none");
});

test("the words or the verb pick the act; a verb finds only things that take it now", () => {
  assert.equal(find(hix, "lock chest", { at }).found[0].act, "object:e_ch:lock");
  assert.deepEqual(find(hix, "chest", { at }).found[0].also, ["object:e_ch:lock"]);
  assert.equal(find(hix, "", { verb: "unlock", at }).found.length, 0, "nothing is locked");
  assert.equal(find(hix, "", { verb: "unlock", at, states: { e_ch: { locked: true } } }).found[0].act, "object:e_ch:unlock");
  assert.equal(find(hix, "switch on lamp", { at, states: { e_l1: { on: false } } }).found[0].act, "object:e_l1:switch-on");
});

test("a thing's hand acts are vouched for by the catalog and named by query", () => {
  assert.equal(hix.knows("object:e_l1:switch-on"), true);
  assert.equal(hix.knows("object:e_l2:switch-on"), false);
  assert.equal(hix.knows("object:e_l1:fly"), false);
  const [t] = query(hix, [{ thing: "e_ch" }], { at, states: { e_ch: { open: true } } });
  assert.deepEqual(t.state, { open: true, locked: false }); assert.deepEqual(t.acts, ["object:e_ch:close"]);
  assert.deepEqual(handActs(hix, handCat.things.find((t) => t.id === "e_ch"), {}).map((a) => a.verb), ["open", "lock"]);
  assert.equal(hix.knows("object:e_l3:dim"), true, "a revision's own entry"); assert.equal(hix.knows("object:e_l1:dim"), false);
  assert.deepEqual(handActs(hix, handCat.things.find((t) => t.id === "e_bd"), {}).map((a) => a.verb), ["write", "erase"], "a field the catalog does not publish is the world's to judge");
});

test("words that only say the verb narrow nothing: \"play music\" --verb play-music finds the instrument (#1737, lane M4)", () => {
  const withViolin = { ...cat, acts: [...cat.acts, { id: "play-music:play-music.e_v1", verb: "play-music", place: "g-village", thing: "e_v1", at: [55, 2], label: "Fiddle a tune (bandstand violin in Eden Village)" }] };
  const ix = indexCatalog(withViolin);
  for (const words of ["play music", "music", "play", ""]) assert.equal(find(ix, words, { verb: "play-music" }).found[0]?.act, "play-music:play-music.e_v1", words);
  assert.equal(find(ix, "violin", { verb: "play-music" }).found[0]?.act, "play-music:play-music.e_v1");
  assert.equal(find(ix, "play music in the library", { verb: "play-music" }).found.length, 0, "a place word still narrows");
});

test("a word that is a verb of the world asks for it first; an act that needs others comes after one done alone (#1737)", () => {
  const ix = indexCatalog({ ...cat, acts: [...cat.acts, { id: "read:read.e_c0", verb: "read", place: "g-library.reading", thing: "e_c0", at: [71, 1], label: "read (library chair in Reading Room)" }] });
  const rows = find(ix, "read a book in the library").found;
  assert.equal(rows[0]?.verb, "read", JSON.stringify(rows.map((r) => r.act)));
  assert.ok(rows.findIndex((r) => r.verb === "book-club") > rows.findIndex((r) => r.verb === "read"));
});

test("find --outline: a place's outline and the named spots and things inside it, with positions, from the local copy (#1922)", () => {
  const pitch = indexCatalog({ ...cat, places: [...cat.places, { id: "g-sports-football", name: "Football Pitch", kind: "sports", parent: "world", at: [61, 112], outline: [[36, 97], [86, 97], [86, 127], [36, 127]] }],
    things: [...cat.things, { id: "e_goal_w", name: "goal-west", kind: "core-goal", place: "world", at: [36.4, 112] }, { id: "e_goal_e", name: "goal-east", kind: "core-goal", place: "world", at: [86, 112] }, { id: "e_far", name: "far-bench", kind: "core-bench-seat", place: "world", at: [20, 112] }],
    acts: [...cat.acts, { id: "kick:kick.e_ball", verb: "kick", place: "g-sports-football", thing: "e_ball", at: [61, 112], label: "kick the ball (Football Pitch)" }] });
  const row = find(pitch, "football pitch", { at, outline: true }).found[0];
  assert.equal(row.id, "g-sports-football");
  assert.deepEqual(row.outline, [[36, 97], [86, 97], [86, 127], [36, 127]]);
  assert.deepEqual(row.inside, [{ name: "kick the ball (Football Pitch)", act: "kick:kick.e_ball", at: [61, 112] }, { name: "goal-west", id: "e_goal_w", at: [36.4, 112] }, { name: "goal-east", id: "e_goal_e", at: [86, 112] }]);
  assert.equal(find(pitch, "football pitch", { at }).found[0].outline, undefined, "without the flag a place row is as before");
  assert.ok(find(ix, "library", { at, outline: true }).found[0].inside.some((r) => r.act === "read:read.e_t1"), "a place with no outline lists what its parts hold");
});
