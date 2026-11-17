// SA-C5: the brief, one read at the start of a turn. A stand-in world with a room of 40 things of 20 kinds.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { changesOf, snapshotOf, ROOM_BRIEF_BYTES } from "./room.mjs";
import { indexCatalog } from "./catalog.mjs";

const CLI = fileURLToPath(new URL("./eden.mjs", import.meta.url));
const KINDS = ["bench", "lamp", "kettle", "table", "chair", "shelf", "stove", "sink", "bed", "desk", "clock", "mirror", "rug", "radio", "piano", "easel", "sofa", "fridge", "barrel", "ladder"];
const PLACES = [
  { id: "world", name: "World", kind: "region", parent: null, at: [0, 0] },
  { id: "hall", name: "Hall", kind: "room", parent: "world", at: [20, 0] },
  { id: "library", name: "Library", kind: "room", parent: "world", at: [60, 0] },
  { id: "garden", name: "Garden", kind: "garden", parent: "world", at: [20, 90] },
  { id: "pond", name: "Pond", kind: "water", parent: "garden", at: [40, 120], fixed: true },
  { id: "cafe", name: "Cafe", kind: "room", parent: "world", at: [150, 40] },
];
const CARDS = { room: { purpose: "A closed space with a roof: things inside it are in reach together." }, garden: { purpose: "Open ground with plants; walk in it, sit in it." }, water: { purpose: "Still water: look at it, it is not walked on." },
  ...Object.fromEntries(KINDS.map((k) => [k, { purpose: `What a ${k} is for: one line of purpose, written by the entry's own author.` }])) };
const THINGS = KINDS.flatMap((k, i) => [1, 2].map((n) => ({ id: `${k}_${n}`, name: `${k[0].toUpperCase()}${k.slice(1)} ${n}`, kind: k, place: "hall", at: [18 + i * 0.1, n] })));
const ELSEWHERE = [{ id: "book_1", name: "Book 1", kind: "book", place: "library", at: [60, 1] }];

async function world() {
  const catalog = { contract: "soul-catalog/1", worldId: "w", scope: "public", placeVerbs: ["walk"], anywhere: [], moves: {}, places: PLACES, things: [...THINGS, ...ELSEWHERE], acts: [], kinds: {}, entries: {}, cards: CARDS };
  const asked = [];
  const state = { things: {}, souls: [{ id: "me", name: "Me", place: "hall", at: [20, 1], hands: { left: null, right: null } }] };
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
      const send = (o, h = {}) => { res.writeHead(200, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
      if (req.url === "/v1/edge/catalog") return send(catalog, { etag: '"c1"' });
      if (req.url === "/v1/edge/live") return send({ epoch: "e", seq: 1, souls: state.souls, things: state.things, catalog: "c1" });
      asked.push(req.url); send({ accepted: true });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, asked, state, url: `http://127.0.0.1:${server.address().port}` };
}
const home = (url) => { const dir = mkdtempSync(join(tmpdir(), "eden-room-")); writeFileSync(join(dir, ".eden-agent.json"), JSON.stringify({ world: url, token: "tok", soul: "me" })); return dir; };
const run = (dir, ...args) => new Promise((res) => execFile(process.execPath, [CLI, ...args], { cwd: dir }, (e, out, err) => { if (!out) console.log(err); res({ code: e?.code ?? 0, raw: out, out: out ? JSON.parse(out) : null }); }));
const bytes = (r) => Buffer.byteLength(r.raw);

test("step 0: today's look of the staged room, its size and what it leaves out", async (t) => {
  const w = await world(); t.after(() => w.server.close());
  const dir = home(w.url), look = await run(dir, "look"), here = look.out.here;
  const named = new Set(Object.keys(here.things ?? {}));
  console.log(`step 0: look is ${bytes(look)} bytes, names ${named.size} of ${KINDS.length} kinds${here.cut ? `, cut ${JSON.stringify(here.cut)}` : ""}`);
  assert.ok(bytes(look) > 0);
});

test("A1: the brief of the staged room is under 2,000 bytes and names or counts every kind", async (t) => {
  const w = await world(); t.after(() => w.server.close());
  const r = await run(home(w.url), "brief");
  console.log(`A1: brief is ${bytes(r)} bytes\n${r.raw}`);
  assert.ok(bytes(r) < 2000, `${bytes(r)} bytes`);
  assert.ok(ROOM_BRIEF_BYTES < 2000);
  for (const k of KINDS) assert.ok(r.out.room.some((row) => row.startsWith(`${k} x2`)), `${k} is named with its count`);
  assert.equal(r.out.holding, "nothing in my hands");
  assert.equal(r.out.plan, "none");
  assert.match(r.out.me, /^Hall/);
  assert.ok(r.out.outward.length >= 3 && r.out.outward[0].startsWith("Library"), "cards go outward, nearest first");
  assert.match(r.out.outward[0], /walk:library: A closed space/);
  assert.equal(r.out.beyond.thingsElsewhere, 1);
  assert.deepEqual(w.asked, [], "nothing was sent");
});

test("A2: a second read with nothing changed says so in one line; a change is named", async (t) => {
  const w = await world(); t.after(() => w.server.close());
  const dir = home(w.url);
  const first = await run(dir, "brief");
  assert.match(first.out.changed[0], /first read/);
  const second = await run(dir, "brief");
  assert.equal(typeof second.out.changed, "string");
  assert.match(second.out.changed, /^nothing/);
  assert.ok(!second.out.changed.includes("\n"));
  // the world moves on: a thing's state changes and I pick something up; the copy serve keeps on disk shows it
  const file = join(dir, "world-live.json"), live = JSON.parse(readFileSync(file, "utf8"));
  live.live.things.kettle_1 = { water: "hot" };
  live.live.souls[0].hands = { left: "mug_1", right: null };
  writeFileSync(file, JSON.stringify(live));
  const third = await run(dir, "brief");
  assert.deepEqual(third.out.holding, ["mug_1"]);
  assert.ok(third.out.changed.includes('kettle_1 water: unset to "hot"'));
  assert.ok(third.out.changed.some((l) => /^holding: nothing to mug_1$/.test(l)));
  // another answer ends with what changed since the brief
  const found = await run(dir, "find", "kettle 1");
  assert.match(found.out.changed, /^nothing/);
});

test("A3: each of the 40 things is found by find", async (t) => {
  const w = await world(); t.after(() => w.server.close());
  const dir = home(w.url);
  for (const th of THINGS) {
    const r = await run(dir, "find", th.name);
    assert.ok(r.out.found.some((f) => f.id === th.id), `${th.name} is found`);
  }
  assert.equal(THINGS.length, 40);
});

test("changesOf: a plan step, a move and a kind's count are plain facts", () => {
  const ix = indexCatalog({ contract: "soul-catalog/1", places: PLACES, things: THINGS, acts: [], kinds: {}, entries: {} });
  const a = snapshotOf(ix, { me: { place: "hall" }, live: null, plan: { id: "x", step: 1, of: 3, state: "running" }, selfId: "me" });
  const b = snapshotOf(ix, { me: { place: "library" }, live: null, plan: { id: "y", step: 2, of: 3, state: "running" }, selfId: "me" });
  assert.deepEqual(changesOf(a, b, ix), ["I moved: Hall to Library", "plan: step 1 to 2 of 3, running"]);
  assert.deepEqual(changesOf(a, a, ix), []);
});
