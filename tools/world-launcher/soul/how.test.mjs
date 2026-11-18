// SA-C4b: a how-to written in an entry, read from the client's copy and returned as a checked plan of real things. A stand-in world.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { how, HOW_STEPS_MAX } from "./how.mjs";
import { indexCatalog } from "./catalog.mjs";

const CLI = fileURLToPath(new URL("./eden.mjs", import.meta.url));
const KETTLE = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/kinds/kitchen/kettle.json", import.meta.url)), "utf8"));
const BODY = { hands: { left: null, right: null }, effector_mm: [-60, 40, 400] };
const PLACES = [{ id: "world", name: "World", kind: "region", parent: null, at: [0, 0] }, { id: "hall", name: "Hall", kind: "room", parent: "world", at: [20, 0] }];

async function world({ things, truth = {} }) {
  const catalog = { contract: "soul-catalog/1", worldId: "w", scope: "public", placeVerbs: ["walk"], anywhere: [], moves: { press: { reach_mm: 600 } }, places: PLACES, things, acts: [], kinds: {}, entries: { "eden:kettle": KETTLE } };
  const asked = [];
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
      const send = (o, h = {}) => { res.writeHead(200, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
      if (req.url === "/v1/edge/catalog") return send(catalog, { etag: '"c1"' });
      if (req.url === "/v1/edge/live") return send({ epoch: "e", seq: 1, souls: [{ id: "me", name: "Me", place: "hall", at: [0, 0], ...BODY }], things: truth, catalog: "c1" });
      asked.push(req.url); send({ accepted: true });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, asked, url: `http://127.0.0.1:${server.address().port}` };
}
const home = (url) => { const dir = mkdtempSync(join(tmpdir(), "eden-how-")); writeFileSync(join(dir, ".eden-agent.json"), JSON.stringify({ world: url, token: "tok", soul: "me" })); return dir; };
const run = (dir, ...args) => new Promise((res) => execFile(process.execPath, [CLI, ...args], { cwd: dir }, (e, out) => res({ code: e?.code ?? 0, out: out ? JSON.parse(out) : null })));
const KETTLE_THING = [{ id: "kettle", name: "Kettle", kind: "eden:kettle", place: "hall", at: [1, 0] }];

test("A1: how for tea returns at most six steps naming real things, cut at the wait, with the rest as a wake entry", async (t) => {
  const w = await world({ things: KETTLE_THING, truth: { kettle: { water: 1000, heating: false } } });
  t.after(() => w.server.close());
  const r = (await run(home(w.url), "how", "tea")).out;
  assert.equal(r.how, "tea");
  assert.match(r.text, /Fill the kettle at a tap, switch it on/);
  assert.equal(r.with.thing, "kettle");
  assert.deepEqual(r.done, [{ form: "fill", act: "object:kettle:fill", why: "already so on this copy: water is 1000" }], "a kettle already filled passes over fill and says so");
  assert.ok(r.steps.length >= 1 && r.steps.length <= HOW_STEPS_MAX);
  assert.deepEqual(r.steps.map((s) => s.act), ["object:kettle:switch_on", "object:kettle:pour"], "each step is a form of a real thing");
  assert.equal(r.steps[0].can, "yes", "the first step is checked on this copy");
  assert.equal(r.steps[0].then_waits_s, 150, "switching on starts a wait the client schedules; the world never waits");
  assert.deepEqual(r.plan, ["object:kettle:switch_on"], "the plan runs up to the wait");
  assert.deepEqual(r.later.plan, ["object:kettle:pour"]);
  assert.match(r.later.wake, /^wake add thing-state '\{"thing":"kettle","field":"heating","is":false\}' --plan '\["object:kettle:pour"\]' --end \d{4}-/);
  assert.deepEqual(w.asked, [], "nothing was sent");
});

test("A2: in a world with no kettle the how-to names the kind", async (t) => {
  const w = await world({ things: [] });
  t.after(() => w.server.close());
  const r = (await run(home(w.url), "how", "tea")).out;
  assert.equal(r.how, "tea");
  assert.deepEqual(r.steps, []);
  assert.equal(r.missing[0].kind, "eden:kettle");
  assert.equal(r.plan, undefined);
  assert.equal((await run(home(w.url), "how", "juggle")).out.how, null);
});

test("a first step that is not possible is said, and --run starts nothing", async (t) => {
  const w = await world({ things: KETTLE_THING, truth: { kettle: { water: 0, heating: false } } });
  t.after(() => w.server.close());
  const dir = home(w.url);
  const r = (await run(dir, "how", "tea")).out;
  assert.equal(r.steps[0].form, "fill", "an empty kettle's tea starts with fill");
  assert.equal(r.steps[0].can, "no");
  assert.match(r.next, /not possible now/);
  const started = await run(dir, "how", "tea", "--run");
  assert.equal(started.code, 2);
  assert.equal(started.out.started, false);
});

test("the nearest thing of the kind is chosen, and a long chain is cut at six", () => {
  const cat = { things: [{ id: "far", name: "Far", kind: "k", place: "hall", at: [90, 0] }, { id: "near", name: "Near", kind: "k", place: "hall", at: [2, 0] }], places: PLACES, acts: [], kinds: {}, placeVerbs: [], anywhere: [],
    entries: { k: { forms: { a: { starts: "act", needs: [], effects: [] } }, text: { t: "do many things" }, howtos: { many: { text: "t", steps: Array.from({ length: 8 }, () => ({ form: "a" })) } } } } };
  const r = how(indexCatalog(cat), "many things", { at: [0, 0] });
  assert.equal(r.with.thing, "near");
  assert.equal(r.steps.length, HOW_STEPS_MAX);
  assert.match(r.cut, /2 more steps/);
  assert.equal(r.later, undefined);
});
