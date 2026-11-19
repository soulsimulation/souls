// SA-C3: "can I?" is answered in the agent's client, from its own copy of the world and the world's own rules, with nothing sent;
// after a refusal that carries the world's verdict the copy matches what the world reported. A stand-in world with one kettle.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../../../packages/form-rules/src/rules.ts";

const CLI = fileURLToPath(new URL("./eden.mjs", import.meta.url));
const KETTLE = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/kinds/kitchen/kettle.json", import.meta.url)), "utf8"));
const BODY = { hands: { left: null, right: null }, effector_mm: [-60, 40, 400] };

/** The world: one kettle whose water and heating are what `truth` says; it decides an act with the same library. `body` is published
 *  on the Soul's live row only when the test wants the client to hold it. */
async function world({ truth, body = null }) {
  const asked = [], reads = [];
  const catalog = {
    contract: "soul-catalog/1", worldId: "w", scope: "public", placeVerbs: ["walk"], anywhere: [], moves: body ? { press: { reach_mm: 600 } } : {},
    places: [{ id: "world", name: "World", kind: "region", parent: null, at: [0, 0] }, { id: "hall", name: "Hall", kind: "room", parent: "world", at: [20, 0] }],
    things: [{ id: "kettle", name: "Kettle", kind: "eden:kettle", place: "hall", at: [1, 0] }],
    acts: [], kinds: {}, entries: { "eden:kettle": KETTLE },
  };
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
      const send = (o, h = {}) => { res.writeHead(200, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
      if (req.url === "/v1/edge/catalog") { reads.push("catalog"); return send(catalog, { etag: '"c1"' }); }
      if (req.url === "/v1/edge/live") { reads.push("live"); return send({ epoch: "e", seq: 1, souls: [{ id: "me", name: "Me", place: "hall", at: [0, 0], ...(body ?? {}) }], things: { kettle: { ...truth } }, catalog: "c1" }); }
      const act = JSON.parse(b || "{}"); asked.push(act.capability);
      const v = decide({ kinds: { "eden:kettle": KETTLE }, act: { this: "kettle", form: "switch_on" }, asker: { sees: "all" },
        state: { actor: "me", nodes: { kettle: { kind: "eden:kettle", fields: { ...truth } }, me: body ?? BODY }, moves: { press: { reach_mm: 600 } } } });
      if (v.verdict === "yes") return send({ accepted: true, receipt: { id: "r1", capability: act.capability, phase: "started" }, channel: "body" });
      send({ accepted: false, code: "form.refused", reason: "The kettle cannot do that now.", decided: v });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, asked, reads, truth, url: `http://127.0.0.1:${server.address().port}` };
}
const home = (url) => { const dir = mkdtempSync(join(tmpdir(), "eden-can-")); writeFileSync(join(dir, ".eden-agent.json"), JSON.stringify({ world: url, token: "tok", soul: "me" })); return dir; };
const run = (dir, ...args) => new Promise((res) => execFile(process.execPath, [CLI, ...args], { cwd: dir }, (e, out) => res({ code: e?.code ?? 0, out: out ? JSON.parse(out) : null })));

test("A1: an empty kettle: the client names what is missing and the next act, and sends no act", async (t) => {
  const w = await world({ truth: { water: 0, heating: false }, body: BODY });
  t.after(() => w.server.close());
  const dir = home(w.url);
  const r = (await run(dir, "can", "kettle", "switch_on")).out;
  assert.equal(r.can, "no");
  assert.equal(r.missing.field, "water");
  assert.equal(r.missing.found, 0);
  assert.match(r.missing.text, /water is 0; this needs it at least 1/);
  assert.deepEqual(r.next, { act: "object:kettle:fill" }, "the world's verdict names fill, the holder's form whose transfer from a tap fills it: the next act is fill");
  assert.equal(typeof r.age_s, "number");
  assert.deepEqual(w.asked, [], "no act was sent");
  const again = (await run(dir, "can", "object:kettle:switch_on")).out;
  assert.equal(again.can, "no", "the act id names the same question");
});

test("a kettle that is ready is yes when the body is held, and unknown (never a no) when the copy has no body reading", async (t) => {
  const ready = { water: 1000, heating: false };
  const withBody = await world({ truth: ready, body: BODY }), without = await world({ truth: ready });
  t.after(() => { withBody.server.close(); without.server.close(); });
  assert.equal((await run(home(withBody.url), "can", "kettle", "switch_on")).out.can, "yes");
  const u = (await run(home(without.url), "can", "kettle", "switch_on")).out;
  assert.equal(u.can, "unknown");
  assert.equal(u.not_checked[0].kind, "within_reach");
  const out = (await run(home(withBody.url), "can", "kettle", "switch_on")).out;
  assert.deepEqual([withBody.asked, without.asked], [[], []]);
  assert.equal(out.can, "yes");
});

test("a definite no from the thing's state wins over what the copy cannot judge; a forms list answers each form", async (t) => {
  const w = await world({ truth: { water: 0, heating: true } });
  t.after(() => w.server.close());
  const dir = home(w.url);
  const r = (await run(dir, "can", "kettle", "switch_on")).out;
  assert.equal(r.can, "no");
  assert.equal(r.missing.field, "heating", "the first unmet need is named");
  const all = (await run(dir, "can", "kettle")).out;
  assert.deepEqual(all.forms.map((f) => f.form), ["fill", "switch_on", "pour"]);
  assert.equal(all.forms.find((f) => f.form === "switch_on").can, "no");
});

test("A2: after a refusal the client's copy matches what the world reported, and says what changed", async (t) => {
  const w = await world({ truth: { water: 1000, heating: false }, body: BODY });
  t.after(() => w.server.close());
  const dir = home(w.url);
  assert.equal((await run(dir, "can", "kettle", "switch_on")).out.can, "yes", "the copy says the kettle holds water");
  w.truth.water = 0;   // the world moved on: someone poured it out
  const refused = (await run(dir, "act", "object:kettle:switch_on")).out;
  assert.equal(refused.accepted, false);
  assert.deepEqual(refused.changed, [{ thing: "kettle", field: "water", was: 1000, now: 0 }]);
  assert.equal(refused.missing.field, "water");
  assert.deepEqual(w.asked, ["object:kettle:switch_on"]);
  const copy = JSON.parse(readFileSync(join(dir, "world-live.json"), "utf8"));
  assert.equal(copy.live.things.kettle.water, 0, "the copy on disk is what the world read");
  const after = (await run(dir, "can", "kettle", "switch_on")).out;
  assert.equal(after.can, "no", "the next question is answered on the corrected copy");
  assert.equal(w.asked.length, 1, "and still sends nothing");
  const second = (await run(dir, "act", "object:kettle:switch_on")).out;
  assert.deepEqual(second.changed, [], "a copy that already agrees changes nothing");
});
