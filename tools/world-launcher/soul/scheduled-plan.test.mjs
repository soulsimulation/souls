// SA-C4a: a how-to can span a wait. The resident holds one schedule entry (a trigger, the steps to send, an end) and sends the
// steps when the trigger holds, with no model turn. A stand-in world: a kettle that boils on the test's say, and acts that complete.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, parseRule } from "./wake.mjs";
import { parsePlanSteps } from "./eden.mjs";

const CLI = fileURLToPath(new URL("./eden.mjs", import.meta.url));
const CATALOG = { contract: "soul-catalog/1", worldId: "w1", scope: "public", placeVerbs: [], anywhere: [],
  places: [{ id: "kitchen", name: "Kitchen", kind: "room", parent: null, at: [0, 0] }],
  things: [{ id: "kettle", name: "Kettle", kind: "kettle", place: "kitchen", at: [1, 0] }, { id: "cup", name: "Cup", kind: "cup", place: "kitchen", at: [2, 0] }],
  acts: [], kinds: { kettle: { acts: [{ verb: "pour", label: "Pour" }], state: { water: "cold" } }, cup: { acts: [{ verb: "steep", label: "Steep" }], state: {} } } };
const until = async (f, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return null; };

async function world(t) {
  const dir = mkdtempSync(join(tmpdir(), "souls-sched-")), w = { dir, kettle: "cold", acts: [], calls: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://w"), p = url.pathname;
    let body = ""; for await (const c of req) body += c;
    const json = (status, v) => { if (!res.destroyed) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); } };
    w.calls.push(p);
    if (p === "/v1/edge/catalog") return json(200, CATALOG);
    if (p === "/v1/edge/live") return json(200, { contract: "soul-live/1", tick: 1, souls: [{ id: "s_me", name: "Me", at: [0, 0], place: "kitchen", doing: null }], things: { kettle: { water: w.kettle } }, speech: [] });
    if (p === "/v1/edge/act") { const b = JSON.parse(body); w.acts.push({ id: b.capability, at: Date.now() }); return json(200, { accepted: true, receipt: { id: `r_${w.acts.length}`, capability: b.capability, phase: "completed" }, channel: "body" }); }
    if (p === "/v1/edge/inbox/listen") { await new Promise((r) => setTimeout(r, 200)); return json(200, { inbox: { connected: true }, backlog: [] }); }
    if (p === "/v1/edge/wait") { await new Promise((r) => setTimeout(r, 200)); return json(200, { events: [], cursor: url.searchParams.get("after") ?? "c_0" }); }
    return json(404, { error: { code: "not-found", message: p } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  writeFileSync(join(dir, ".eden-agent.json"), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: "s_me", token: "synthetic-sched-token" }), { mode: 0o600 });
  w.cli = (...args) => new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { err += c; });
    child.on("exit", (code) => { let j = null; try { j = JSON.parse(out); } catch { /* text */ } done({ code, err, json: j, out }); });
  });
  w.state = () => JSON.parse(readFileSync(join(dir, ".eden-serve.json"), "utf8"));
  w.copyHas = () => { try { return JSON.parse(readFileSync(join(dir, "world-live.json"), "utf8")).live?.things?.kettle?.water === "boiled"; } catch { return false; } };
  t.after(async () => { await w.cli("serve", "--stop"); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  return w;
}
const TEA = '["object:kettle:pour","object:cup:steep"]';

test("A1: the tea chain continues within 2 s of the copy showing the kettle boiled, with no model turn", async (t) => {
  const w = await world(t);
  assert.equal((await w.cli("serve")).code, 0);
  assert.ok(await until(() => existsSync(join(w.dir, "world-live.json"))), "serve took a copy of the world");
  const end = new Date(Date.now() + 120_000).toISOString();
  const added = await w.cli("wake", "add", "thing-state", '{"thing":"kettle","field":"water","is":"boiled"}', "--plan", TEA, "--end", end);
  assert.equal(added.code, 0, added.err);
  assert.deepEqual(added.json.rules.at(-1).plan, ["object:kettle:pour", "object:cup:steep"]);
  await new Promise((r) => setTimeout(r, 2_500));   // the rule takes the kettle's state as it is
  assert.deepEqual(w.acts, [], "nothing is sent while the kettle is cold");
  w.kettle = "boiled";
  const seen = await until(() => w.copyHas() && Date.now());
  assert.ok(seen, "the copy shows the kettle boiled");
  assert.ok(await until(() => w.acts.length === 2), `both steps were sent: ${JSON.stringify(w.acts)}`);
  assert.deepEqual(w.acts.map((a) => a.id), ["object:kettle:pour", "object:cup:steep"]);
  const lag = w.acts[0].at - seen;
  assert.ok(lag <= 2_000, `the first step went ${lag} ms after the copy showed it`);
  assert.deepEqual(w.state().wake.queue.map((q) => q.id), ["plan-finished"], "the only wake is the chain's own end, after it ran: no turn was asked for between");
  assert.equal(w.state().wake.rules.at(-1).ended, "fired");
  console.log(`A1 lag from the copy showing it to the first step: ${lag} ms`);
});

test("A2: past its end the entry is dropped and the mind is told once; an `at` entry sends at its time", async (t) => {
  const w = await world(t);
  assert.equal((await w.cli("serve")).code, 0);
  assert.ok(await until(() => existsSync(join(w.dir, "world-live.json"))));
  const soon = new Date(Date.now() + 1_500).toISOString();
  assert.equal((await w.cli("wake", "add", "thing-state", '{"thing":"kettle","field":"water","is":"boiled"}', "--plan", TEA, "--end", soon)).code, 0);
  const wakeAt = new Date(Date.now() + 1_000).toISOString();
  assert.equal((await w.cli("wake", "add", "at", wakeAt, "--plan", '["object:cup:steep"]')).code, 0);
  assert.ok(await until(() => w.state().wake.rules.at(-2).ended === "dropped"), "the rule ended dropped past its end");
  assert.ok(await until(() => w.acts.length === 1), "the entry on a time sent its step");
  assert.deepEqual(w.acts.map((a) => a.id), ["object:cup:steep"]);
  w.kettle = "boiled";   // too late: it does not send
  await new Promise((r) => setTimeout(r, 3_000));
  assert.equal(w.acts.length, 1, "a dropped entry sends nothing, however late the kettle boils");
  const q = w.state().wake.queue.filter((x) => x.kind === "thing-state");
  assert.equal(q.length, 1); assert.equal(q[0].count, 1, "told once");
  assert.match(q[0].why, /was dropped: its end .* passed first/);
});

test("an entry waits for a plan that is running, within its end", () => {
  const rule = { id: "w1", ...parseRule(["at", "2026-11-17T10:00:00Z", "--plan", '["walk:table"]']) };
  assert.equal(rule.end, "2026-11-17T10:10:00.000Z", "an end by default: ten minutes after its time");
  const T = Date.parse("2026-11-17T10:00:01Z"), st = { events: [], plan: { state: "running" }, me: "s_me", since: 0 };
  let r = evaluate([rule], st, T);
  assert.deepEqual(r.fired, [], "a plan is running: it waits");
  r = evaluate(r.rules, { ...st, plan: { state: "done" } }, T + 2_000);
  assert.deepEqual(r.fired.map((f) => f.plan), [["walk:table"]], "it sends when that one is over");
  assert.equal(evaluate(r.rules, st, T + 4_000).fired.length, 0, "and only once");
  assert.throws(() => parseRule(["at", "2026-11-17T10:00:00Z", "--end", "2026-11-17T11:00:00Z"]), /--plan/);
  assert.throws(() => parseRule(["thing-state", '{"thing":"k","field":"f"}', "--plan", "[\"walk:a\"]"]), /needs its end/);
  assert.throws(() => parseRule(["idle", '{"minutes":10}', "--plan", '["walk:a"]']), /goes on/);
});

test("A3: no plan step and no act carries a start time or a condition", async (t) => {
  for (const key of ["at", "when", "after", "if", "until", "wait", "delay", "start", "condition", "waitFor"]) {
    assert.throws(() => parsePlanSteps(JSON.stringify([{ id: "walk:table", [key]: "10:00" }])), /carries no start time or condition/, key);
  }
  assert.deepEqual(parsePlanSteps('["walk:table",{"id":"sit:bench","params":{"seconds":5}}]').steps.map((s) => s.id), ["walk:table", "sit:bench"], "ids and params still pass");
  const w = await world(t);
  assert.equal((await w.cli("wake", "add", "at", "2099-01-01T00:00:00Z", "--plan", '[{"id":"walk:table","when":"kettle boiled"}]')).code, 1, "a scheduled plan's steps are held to the same rule");
  assert.equal((await w.cli("plan", '[{"id":"walk:table","after":"5m"}]')).code, 1);
  for (const flag of ["--at", "--when", "--if", "--after", "--delay"]) {
    const r = await w.cli("act", "walk:table", flag, "10:00");
    assert.notEqual(r.code, 0, `act ${flag}`);
  }
  assert.equal(w.acts.length, 0, "none of them reached the world");
});
