// SA-C9: one plan step repeats over the things of a kind. "Turn off all the lamps" is {"each":"lamp","form":"switch_off","in":"room","max":6}:
// the client lists the lamps from its own copy, then the resident runs the form on each in turn, asking `can` of the copy before each
// and stopping where one refuses, with no model turn between. A stand-in world with a hall of six lamps and a cellar lamp in the same house.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlanSteps } from "./eden.mjs";
import { expandEach } from "./room.mjs";
import { indexCatalog } from "./catalog.mjs";

const CLI = fileURLToPath(new URL("./eden.mjs", import.meta.url));
const LAMP = { format: "souls-entry/1", kind: "lamp", owner: "thing", state: { on: { n: 1, type: "bool", default: true, audience: "public" } },
  forms: { switch_off: { who: "anyone", starts: "act", needs: [{ need: "state", field: "on", is: true }], steps: [], effects: [{ change: "set", field: "on", to: false }] } } };
const lamps = (ids, place, x0) => ids.map((id, i) => ({ id, name: id, kind: "lamp", place, at: [x0 + i, 0] }));
const CATALOG = { contract: "soul-catalog/1", worldId: "w1", scope: "public", placeVerbs: [], anywhere: [], moves: {},
  places: [{ id: "house", name: "House", kind: "building", parent: null, at: [0, 0] }, { id: "hall", name: "Hall", kind: "room", parent: "house", at: [0, 0] }, { id: "cellar", name: "Cellar", kind: "room", parent: "house", at: [30, 0] }],
  things: [...lamps(["l1", "l2", "l3", "l4", "l5", "l6"], "hall", 1), ...lamps(["c1"], "cellar", 30)], acts: [], kinds: {}, entries: { lamp: LAMP } };
const until = async (f, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return null; };

async function world(t, { off = [], refuse = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "souls-each-")), w = { dir, acts: [] };
  const things = Object.fromEntries(CATALOG.things.map((x) => [x.id, { on: !off.includes(x.id) }]));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://w"), p = url.pathname;
    let body = ""; for await (const c of req) body += c;
    const json = (status, v) => { if (!res.destroyed) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); } };
    if (p === "/v1/edge/catalog") return json(200, CATALOG);
    if (p === "/v1/edge/live") return json(200, { contract: "soul-live/1", tick: 1, souls: [{ id: "s_me", name: "Me", at: [0, 0], place: "hall", doing: null }], things, speech: [] });
    if (p === "/v1/edge/act") {
      const b = JSON.parse(body); w.acts.push(b.capability);
      if (b.capability === refuse) return json(200, { accepted: false, code: "form.refused", reason: "The lamp will not switch." });
      return json(200, { accepted: true, receipt: { id: `r_${w.acts.length}`, capability: b.capability, phase: "completed" }, channel: "body" });
    }
    if (p === "/v1/edge/inbox/listen") { await new Promise((r) => setTimeout(r, 200)); return json(200, { inbox: { connected: true }, backlog: [] }); }
    if (p === "/v1/edge/wait") { await new Promise((r) => setTimeout(r, 200)); return json(200, { events: [], cursor: url.searchParams.get("after") ?? "c_0" }); }
    return json(404, { error: { code: "not-found", message: p } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  writeFileSync(join(dir, ".eden-agent.json"), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: "s_me", token: "synthetic-each-token" }), { mode: 0o600 });
  w.cli = (...args) => new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { err += c; });
    child.on("exit", (code) => { let j = null; try { j = JSON.parse(out); } catch { /* text */ } done({ code, err, json: j, out }); });
  });
  t.after(async () => { await w.cli("serve", "--stop"); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await w.cli("serve")).code, 0);
  assert.ok(await until(() => existsSync(join(dir, "world-live.json"))), "serve took a copy of the world");
  return w;
}
const STEP = (o = {}) => JSON.stringify([{ each: "lamp", form: "switch_off", in: "room", max: 6, ...o }]);
const status = async (w) => (await w.cli("plan", "--status")).json;
const stoppedPlan = (w) => until(async () => { const s = await status(w); return s?.plan?.state === "stopped" ? s.plan : null; });

test("A1: in a room with six lamps one plan step switches all six, with no model turn between", async (t) => {
  const w = await world(t);
  const r = await w.cli("plan", STEP(), "--for", "none");
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(r.json.each, [{ kind: "lamp", in: "room", steps: 6 }]);
  assert.ok(await until(async () => (await status(w))?.planEnded?.length), "the plan ended");
  assert.deepEqual(w.acts, ["l1", "l2", "l3", "l4", "l5", "l6"].map((l) => `object:${l}:switch_off`), "the six, nearest first, once each; the cellar's lamp is not in the room");
  const end = (await status(w)).planEnded.at(-1);
  assert.equal(end.state, "done");
  assert.deepEqual(end.each, [{ kind: "lamp", done: 6, of: 6 }]);
});

test("A2: it stops and reports at the first the world refuses; the rest are not sent", async (t) => {
  const w = await world(t, { refuse: "object:l3:switch_off" });
  assert.equal((await w.cli("plan", STEP(), "--for", "none")).code, 0);
  const stopped = await stoppedPlan(w);
  assert.ok(stopped, "the plan stopped");
  assert.deepEqual(w.acts, ["object:l1:switch_off", "object:l2:switch_off", "object:l3:switch_off"]);
  assert.equal(stopped.step, 3);
  assert.equal(stopped.steps[2].code, "form.refused");
  assert.deepEqual(stopped.steps.slice(3).map((s) => s.state), ["pending", "pending", "pending"]);
  assert.deepEqual(stopped.each, [{ kind: "lamp", done: 2, of: 6 }]);
  assert.match(stopped.next, /Step 3 was refused/);
});

test("A2: a lamp the copy already says cannot be switched is not asked of the world, and the repeat stops there", async (t) => {
  const w = await world(t, { off: ["l4"] });
  assert.equal((await w.cli("plan", STEP(), "--for", "none")).code, 0);
  const stopped = await stoppedPlan(w);
  assert.ok(stopped, "the plan stopped");
  assert.deepEqual(w.acts, ["object:l1:switch_off", "object:l2:switch_off", "object:l3:switch_off"], "l4 was not sent, nor the ones after it");
  assert.equal(stopped.steps[3].code, "can.no");
  assert.match(stopped.steps[3].reason, /on is false/);
  assert.equal(stopped.steps[3].sent, "nothing");
});

test("a house reaches the lamps of every room in it, and max keeps the nearest", async (t) => {
  const w = await world(t);
  const all = await w.cli("plan", STEP({ in: "house", max: 24 }), "--for", "none");
  assert.equal(all.json.each[0].steps, 7);
  const r = await w.cli("plan", STEP({ in: "house", max: 3 }), "--for", "none");
  assert.deepEqual(r.json.each, [{ kind: "lamp", in: "house", steps: 3, left_out: 4, why: "max 3" }]);
});

test("nothing found, a form the kind lacks, and a bad step send nothing", async (t) => {
  const w = await world(t);
  const none = await w.cli("plan", STEP({ each: "chair" }), "--for", "none");
  assert.equal(none.code, 2); assert.match(none.json.reason, /lists no chair in this room: nothing was sent/);
  const form = await w.cli("plan", STEP({ form: "polish" }), "--for", "none");
  assert.equal(form.code, 2); assert.match(form.json.reason, /no form "polish": its forms are switch_off/);
  assert.deepEqual(w.acts, []);
  assert.throws(() => parsePlanSteps(STEP({ max: 0 }), { each: true }), /whole number from 1 to 24/);
  assert.throws(() => parsePlanSteps(STEP({ at: "9am" }), { each: true }), /a repeated step/);
  assert.throws(() => parsePlanSteps(STEP(), {}), /is for plan/, "a schedule entry holds named steps");
});

test("expandEach keeps named steps in place and holds the plan's limit", () => {
  const ix = indexCatalog(CATALOG), me = { place: "hall", at: [0, 0] };
  const e = expandEach(ix, me, [{ id: "walk:house" }, ...parsePlanSteps(STEP({ max: 2 }), { each: true }).steps]);
  assert.deepEqual(e.steps.map((s) => s.id), ["walk:house", "object:l1:switch_off", "object:l2:switch_off"]);
  const two = [...parsePlanSteps(STEP({ in: "house", max: 24 }), { each: true }).steps, ...parsePlanSteps(STEP({ max: 24 }), { each: true }).steps];
  assert.equal(expandEach(ix, me, two, 10).error, "that makes 13 steps; a plan has at most 10");
});
