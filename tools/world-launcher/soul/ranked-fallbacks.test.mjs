// SA-C8: an act carries ranked fallbacks, and the client tries the next with no model turn. A fake world that holds each seat for
// the first Soul to ask, and 20 scripted Souls who all decided on the nearest seat from what they saw a moment ago.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./eden.mjs", import.meta.url));
const SEATS = 20;
const seatAt = (i) => [i * 2, 0];
const CATALOG = {
  contract: "soul-catalog/1", worldId: "w", scope: "public", placeVerbs: ["walk"], anywhere: [],
  places: [{ id: "world", name: "World", kind: "region", parent: null, at: [0, 0] }, { id: "hall", name: "Hall", kind: "room", parent: "world", at: [20, 0] }, { id: "yard", name: "Yard", kind: "region", parent: "world", at: [90, 0] }],
  things: [...Array.from({ length: SEATS }, (_, i) => ({ id: `s${i}`, name: `Stool ${i}`, kind: "stool", place: "hall", at: seatAt(i), seat: true })), { id: "bench-out", name: "Bench", kind: "bench", place: "yard", at: [90, 1], seat: true }],
  acts: [], kinds: {},
};

/** The world: a seat goes to the first Soul that asks for it, and is refused to the rest. `souls` is token → {id, at}.
 *  `lockstep`: the acts are answered in rounds, not as the machine happens to deliver them. A round closes when every Soul still
 *  running (`done(id)` marks one finished) has an act waiting, and its acts are decided in the Souls' order. So the crowd asks
 *  at the same time on every try, the hardest case, and the outcome is the client's alone, whatever the load (#3099 pattern). */
async function world(souls, { lockstep = false } = {}) {
  const taken = new Map(), asked = [], waiting = new Map(), running = new Set(lockstep ? Object.values(souls).map((s) => s.id) : []);
  const decide = (me, body) => {
    asked.push({ soul: me?.id, id: body.capability });
    const seat = /^sit:(.+)$/.exec(body.capability ?? "")?.[1];
    if (!seat || !me) return { accepted: false, code: "capability.unknown", reason: "no" };
    if (taken.has(seat)) return { accepted: false, code: "seat.none-near", reason: "That seat is taken.", did_you_mean: [...Array(SEATS).keys()].filter((i) => !taken.has(`s${i}`)).sort((a, b) => Math.abs(seatAt(a)[0] - me.at[0]) - Math.abs(seatAt(b)[0] - me.at[0])).slice(0, 3).map((i) => ({ id: `sit:s${i}`, label: `Stool ${i}` })) };
    taken.set(seat, me.id);
    return { accepted: true, receipt: { id: `r_${me.id}`, capability: body.capability, phase: "started" }, channel: "body" };
  };
  const round = () => {
    if (!waiting.size || waiting.size < running.size) return;
    const now = [...waiting.values()].sort((a, b) => (a.me.id < b.me.id ? -1 : 1)); waiting.clear();
    for (const w of now) w.send(decide(w.me, w.body));
  };
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
      const send = (o, h = {}) => { res.writeHead(200, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
      if (req.url === "/v1/edge/catalog") return send(CATALOG, { etag: '"c1"' });
      if (req.url === "/v1/edge/live") return send({ epoch: "e", seq: 1, souls: Object.values(souls).map((s) => ({ id: s.id, name: s.id, place: "hall", at: s.at })), things: {}, catalog: "c1" });
      const body = JSON.parse(b || "{}"), me = souls[(req.headers.authorization ?? "").slice(7)];
      if (!running.has(me?.id)) return send(decide(me, body));
      assert.ok(!waiting.has(me.id), `${me.id} sent a second act before the first was answered`);
      waiting.set(me.id, { me, body, send }); round();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const done = (id) => { running.delete(id); round(); };
  return { server, taken, asked, done, url: `http://127.0.0.1:${server.address().port}` };
}
const home = (url, soul, token) => { const dir = mkdtempSync(join(tmpdir(), "eden-ranked-")); writeFileSync(join(dir, ".eden-agent.json"), JSON.stringify({ world: url, token, soul })); return dir; };
const run = (dir, ...args) => new Promise((res) => execFile(process.execPath, [CLI, ...args], { cwd: dir }, (e, out) => res({ code: e?.code ?? 0, out: out ? JSON.parse(out) : null })));
/** The seats a Soul sees, nearest first: what its mind chose from a moment ago. */
const nearest = (x) => [...Array(SEATS).keys()].sort((a, b) => Math.abs(seatAt(a)[0] - x) - Math.abs(seatAt(b)[0] - x) || a - b);
/** 20 Souls arrive together by the door: positions from a fixed generator, so the run repeats. */
function crowd(seed) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  return Array.from({ length: SEATS }, (_, i) => ({ id: `soul${i}`, at: [Math.round(rnd() * 60) / 10, 0] }));
}
/** Every Soul sends one act at the same time, once. Returns how many were accepted on that one call. */
export async function crowdRun({ seed, fallbacks }) {
  const people = crowd(seed), souls = Object.fromEntries(people.map((p) => [`tok-${p.id}`, p])), w = await world(souls, { lockstep: true });
  try {
    const got = await Promise.all(people.map((p) => {
      const order = nearest(p.at[0]), args = ["act", `sit:s${order[0]}`, ...(fallbacks ? ["--else", `sit:s${order[1]}`, "--else", `sit:s${order[2]}`, "--else", "any:sit"] : []), "--json"];
      return run(home(w.url, p.id, `tok-${p.id}`), ...args).finally(() => w.done(p.id));
    }));
    return { accepted: got.filter((g) => g.out.accepted === true).length, sent: w.asked.length, distinct: new Set(w.taken.values()).size, firsts: got.map((g) => g.out.fallback?.rank ?? 1) };
  } finally { w.server.close(); }
}

test("20 Souls choose the nearest seat: without fallbacks few land; with fallbacks 90% or more land on the first call", async () => {
  const rows = [];
  for (const seed of [1, 2]) {
    const without = await crowdRun({ seed, fallbacks: false }), withFb = await crowdRun({ seed, fallbacks: true });
    rows.push({ seed, without: without.accepted, with: withFb.accepted, sent: withFb.sent, ranks: withFb.firsts.join(",") });
    if (process.env.SA_C8_REPORT) console.log(JSON.stringify(rows.at(-1)));
    assert.ok(without.accepted / SEATS <= 0.8, `step 0: ${without.accepted}/${SEATS} without fallbacks`);
    assert.ok(withFb.accepted / SEATS >= 0.9, `${withFb.accepted}/${SEATS} with fallbacks`);
  }
  if (process.env.SA_C8_REPORT) console.log(JSON.stringify(rows));
});

test("a fallback that holds says which one; the list runs out once, with the world's word", async (t) => {
  const people = [{ id: "a", at: [0, 0] }, { id: "b", at: [0, 0] }], souls = Object.fromEntries(people.map((p) => [`tok-${p.id}`, p])), w = await world(souls);
  t.after(() => w.server.close());
  const a = home(w.url, "a", "tok-a"), b = home(w.url, "b", "tok-b");
  assert.equal((await run(a, "act", "sit:s0")).out.accepted, true);
  const held = await run(b, "act", "sit:s0", "--else", "sit:s1");
  assert.equal(held.out.accepted, true); assert.deepEqual(held.out.fallback, { took: "sit:s1", rank: 2, tried: [{ id: "sit:s0", code: "seat.none-near", reason: "That seat is taken." }] });
  w.taken.set("bench-out", "x");
  const c = home(w.url, "a", "tok-a"), before = w.asked.length;
  const out = await run(c, "act", "sit:s0", "--else", "sit:s1", "--else", "sit:bench-out");
  assert.equal(out.out.accepted, false); assert.equal(out.out.code, "act.fallbacks-exhausted");
  assert.deepEqual(out.out.fallback.tried.map((x) => x.id), ["sit:s0", "sit:s1", "sit:bench-out"]);
  assert.ok(out.out.did_you_mean.length > 0, "what is free now");
  assert.equal(w.asked.length - before, 3, "three sends, one answer");
});

test("any:sit stays in the Soul's own room: the bench in the yard is never tried", async (t) => {
  const p = { id: "a", at: [0, 0] }, w = await world({ "tok-a": p });
  t.after(() => w.server.close());
  for (let i = 0; i < SEATS; i++) w.taken.set(`s${i}`, "x");
  const out = await run(home(w.url, "a", "tok-a"), "act", "sit:s0", "--else", "any:sit");
  assert.equal(out.out.code, "act.fallbacks-exhausted");
  assert.ok(!w.asked.some((x) => x.id === "sit:bench-out"));
  assert.equal(w.asked.length, 12, "the first and then one seat at a time, up to twelve sends in all");
});

test("--else needs a value", async () => {
  const r = await run(mkdtempSync(join(tmpdir(), "eden-ranked-")), "act", "sit:s0", "--else");
  assert.notEqual(r.code, 0);
});
