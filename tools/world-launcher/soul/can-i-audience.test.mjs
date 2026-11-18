// The client asks with `sees: ["public"]`. A field whose audience is the rule object `{rule: "everyone"}` (SA-F8, #2849) is
// seen by it; one whose audience is `{rule: "owner"}` is not. Run through the generated eden.mjs, so a stale inlined copy of
// the rules package (one that compares audiences as strings) fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./eden.mjs", import.meta.url));
const BOX = {
  format: "souls-entry/1", kind: "test:box", owner: "thing",
  state: {
    lid: { n: 1, type: "bool", default: false, audience: { rule: "everyone" } },
    lock: { n: 2, type: "bool", default: false, audience: { rule: "owner" } },
  },
  forms: {
    lift: { who: "anyone", starts: "act", needs: [{ need: "state", field: "lid", is: false }], steps: [], effects: [] },
    unlock: { who: "anyone", starts: "act", needs: [{ need: "state", field: "lock", is: true }], steps: [], effects: [] },
  },
};

async function world() {
  const catalog = {
    contract: "soul-catalog/1", worldId: "w", scope: "public", placeVerbs: ["walk"], anywhere: [], moves: {},
    places: [{ id: "world", name: "World", kind: "region", parent: null, at: [0, 0] }, { id: "hall", name: "Hall", kind: "room", parent: "world", at: [20, 0] }],
    things: [{ id: "box", name: "Box", kind: "test:box", place: "hall", at: [1, 0] }],
    acts: [], kinds: {}, entries: { "test:box": BOX },
  };
  const server = createServer((req, res) => {
    req.resume(); req.on("end", () => {
      const send = (o, h = {}) => { res.writeHead(200, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
      if (req.url === "/v1/edge/catalog") return send(catalog, { etag: '"c1"' });
      if (req.url === "/v1/edge/live") return send({ epoch: "e", seq: 1, souls: [{ id: "me", name: "Me", place: "hall", at: [0, 0] }], things: { box: { lid: false, lock: false } }, catalog: "c1" });
      send({ accepted: false, code: "unexpected", reason: "this test sends no act" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const home = (url) => { const dir = mkdtempSync(join(tmpdir(), "eden-can-aud-")); writeFileSync(join(dir, ".eden-agent.json"), JSON.stringify({ world: url, token: "tok", soul: "me" })); return dir; };
const run = (dir, ...args) => new Promise((res) => execFile(process.execPath, [CLI, ...args], { cwd: dir }, (e, out) => res(out ? JSON.parse(out) : null)));

test("a field for everyone is seen with sees [public]; a field for the owner is not", async (t) => {
  const w = await world();
  t.after(() => w.server.close());
  const dir = home(w.url);
  const seen = await run(dir, "can", "box", "lift");
  assert.equal(seen.can, "yes", JSON.stringify(seen));
  const hidden = await run(dir, "can", "box", "unlock");
  assert.equal(hidden.can, "unknown", JSON.stringify(hidden));
  assert.match(hidden.why, /^lock is not visible/);
});
