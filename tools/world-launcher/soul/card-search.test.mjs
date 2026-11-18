// Soul Actions SA-C1 (#2865): a card (one line of purpose, a category, synonyms) on a kind or a place lets `find` rank a
// thing by what it is for. The same ten purpose queries run on a catalog without cards ("today") and with them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexCatalog, find, entryCard, cardOf, CARD_PURPOSE_MAX } from "./catalog.mjs";

/** The purpose line of an example entry: the text its `card` names. */
const lineOf = (file) => { const e = JSON.parse(readFileSync(new URL(`../../../content/kinds/${file}.json`, import.meta.url), "utf8")); return e.text[e.card.text]; };

// kinds as a world publishes them: opaque names, no acts for these things (no activity spot answers a purpose query)
const things = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `e_c${i}`, name: `library/chair-${i}`, kind: "core-chair", place: "g-library", at: [71 + i / 10, 1], seat: true })),
  { id: "e_b1", name: "promenade-bench-1", kind: "core-bench-seat", place: "g-pond", at: [12, 42], seat: true },
  { id: "e_w1", name: "gym-bench-press", kind: "eden-weight-bench", place: "g-library", at: [75, 5] },
  { id: "e_t1", name: "old-oak", kind: "core-tree", place: "g-pond", at: [14, 40] },
  { id: "e_k1", name: "kitchen-unit-2", kind: "eden-kettle", place: "g-library", at: [72, 3] },
  { id: "e_l1", name: "stand-9", kind: "eden-lecture", place: "g-hall", at: [200, 0] },
  { id: "e_s1", name: "shelf-wall-4", kind: "eden-shelving", place: "g-library", at: [73, 2] },
  { id: "e_e1", name: "frame-3", kind: "eden-easel", place: "g-hall", at: [205, 4] },
  { id: "e_f1", name: "ring-1", kind: "eden-firepit", place: "g-pond", at: [20, 40] },
  { id: "e_o1", name: "unit-7", kind: "eden-oven", place: "g-library", at: [74, 3] },
  { id: "e_n1", name: "basin-2", kind: "eden-basin", place: "g-library", at: [76, 3] },
  { id: "e_u1", name: "post-5", kind: "eden-tap", place: "g-pond", at: [15, 41] },
];
const places = [
  { id: "world", name: "World", kind: "region", parent: null, at: [0, 0] },
  { id: "g-library", name: "Eden Library", kind: "building", parent: "world", at: [70, 0] },
  { id: "g-pond", name: "Commons Pond", kind: "water", parent: "world", at: [10, 40] },
  { id: "g-hall", name: "North Hall", kind: "building", parent: "world", at: [200, 0] },
  { id: "g-amph", name: "Eden Amphitheatre", kind: "eden-amphitheatre", parent: "world", at: [300, 0] },
  { id: "g-tea", name: "Eden Tea House", kind: "eden-tea-house", parent: "world", at: [310, 20] },
];
const bare = { contract: "soul-catalog/1", worldId: "w", scope: "public", placeVerbs: ["walk"], anywhere: [], places, things, acts: [], kinds: {} };
// the first three come from the example entries' own card lines; the rest are written in the same shape
const cards = {
  "eden-kettle": { purpose: lineOf("kitchen/kettle"), category: "kitchen", synonyms: ["heat", "brew"] },
  "core-bench-seat": { purpose: lineOf("seating/bench"), category: "seating", synonyms: ["rest"] },
  "eden-lecture": { purpose: lineOf("gathering/lecture"), category: "gathering", synonyms: ["lectern", "speech", "talk"] },
  "core-chair": { purpose: "A chair for one to sit on.", category: "seating" },
  "eden-weight-bench": { purpose: "A padded bench to lift weights lying down.", category: "exercise", synonyms: ["gym"] },
  "core-tree": { purpose: "A tree that gives shade to stand or sit under.", category: "plants" },
  "eden-shelving": { purpose: "Shelves where books are kept and picked out to read.", category: "storage", synonyms: ["library", "store"] },
  "eden-easel": { purpose: "An easel to paint or draw a picture on a canvas.", category: "art", synonyms: ["canvas"] },
  "eden-firepit": { purpose: "A fire to stay warm by; its light and crackle carry 12 m.", category: "outdoors", synonyms: ["campfire", "heat"] },
  "eden-oven": { purpose: "An oven that bakes bread and other dough.", category: "kitchen" },
  "eden-basin": { purpose: "A basin with running water to wash hands.", category: "washing", synonyms: ["sink"] },
  "eden-tap": { purpose: "A tap that fills bottles and cups with clean water.", category: "water", synonyms: ["fountain", "refill"] },
  "eden-amphitheatre": { purpose: "A tiered open-air place to watch a show or a talk.", category: "performance" },
  "eden-tea-house": { purpose: "A small house where tea and cake are served.", category: "cafe", synonyms: ["cafe"] },
};
for (const k of Object.keys(cards)) assert.ok(cards[k].purpose.length <= CARD_PURPOSE_MAX, `${k}: purpose over ${CARD_PURPOSE_MAX}`);

// [query, the kind (or place kind) that is right]
const QUERIES = [
  ["boil water", "eden-kettle"], ["give a talk", "eden-lecture"], ["store books", "eden-shelving"], ["stay warm", "eden-firepit"],
  ["paint a picture", "eden-easel"], ["bake bread", "eden-oven"], ["wash hands", "eden-basin"], ["fill a bottle", "eden-tap"],
  ["watch a show", "eden-amphitheatre"], ["have cake", "eden-tea-house"],
];
const top3 = (cat, q) => find(indexCatalog(structuredClone(cat)), q, { at: [50, 0] }).found.slice(0, 3);
const hits = (cat) => QUERIES.filter(([q, want]) => top3(cat, q).some((r) => r.kind === want));

test("A1: at least eight of ten purpose queries find the right kind in the first three rows", () => {
  const today = hits(bare), now = hits({ ...bare, cards });
  console.log(`today (no cards): ${today.length}/10; with cards: ${now.length}/10`);
  for (const [q, want] of QUERIES) console.log(`${q.padEnd(16)} ${want.padEnd(18)} today ${today.some((h) => h[0] === q) ? "hit " : "miss"}  cards ${now.some((h) => h[0] === q) ? "hit " : "miss"}  ${top3({ ...bare, cards }, q).map((r) => r.kind).join(", ")}`);
  assert.ok(now.length >= 8, `${now.length} of 10`);
});

test("a row carries its purpose line, cut at the limit; a kind without a card is as it was", () => {
  const long = { ...bare, cards: { "eden-oven": { purpose: "x".repeat(200) } } };
  const row = find(indexCatalog(structuredClone(long)), "oven", { at: [50, 0] }).found.find((r) => r.kind === "eden-oven");
  assert.equal(row.purpose.length, CARD_PURPOSE_MAX);
  const plain = find(indexCatalog(structuredClone(bare)), "oven", { at: [50, 0] }).found[0];
  assert.equal(plain.purpose, undefined);
});

test("a card's synonym and category find a thing; the name still wins over the purpose", () => {
  const ix = indexCatalog(structuredClone({ ...bare, cards }));
  assert.equal(find(ix, "sink", { at: [50, 0] }).found[0].kind, "eden-basin");
  assert.equal(find(ix, "kitchen", { at: [50, 0] }).found.slice(0, 2).every((r) => ["eden-kettle", "eden-oven"].includes(r.kind)), true);
  assert.equal(find(ix, "tree", { at: [50, 0] }).found[0].kind, "core-tree");
});

// A world of today sends a kind's card only inside its entry (`catalog.entries`, SA-C3), its words as keys of the entry's text.
test("an entry's card in catalog.entries is the kind's card; catalog.cards wins when a world sends both", () => {
  const kettle = JSON.parse(readFileSync(new URL("../../../content/kinds/kitchen/kettle.json", import.meta.url), "utf8"));
  const thing = { id: "e_k9", name: "run-kettle-1", kind: kettle.kind, place: "g-library", at: [72, 3] };
  const cat = { ...bare, things: [...bare.things, thing], entries: { [kettle.kind]: kettle } };
  assert.deepEqual(entryCard(kettle), { purpose: kettle.text.card, category: "kitchen", synonyms: ["heat", "brew"] });
  assert.equal(entryCard({ kind: "x:y" }), null);
  // "boils" is in the card only, not in the thing's name or kind
  const ix = indexCatalog(structuredClone(cat)), row = find(ix, "boils", { at: [50, 0] }).found[0];
  assert.equal(row.id, "e_k9");
  assert.equal(row.purpose, kettle.text.card);
  assert.equal(cardOf(ix, "e_k9").category, "kitchen");
  assert.equal(cardOf(ix, "e_c1"), null);
  const both = indexCatalog(structuredClone({ ...cat, cards: { [kettle.kind]: { purpose: "A pot that whistles." } } }));
  assert.equal(cardOf(both, "e_k9").purpose, "A pot that whistles.");
  assert.equal(find(both, "boils", { at: [50, 0] }).found.some((r) => r.id === "e_k9"), false);
});
