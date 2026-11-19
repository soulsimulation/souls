// R16's `history` checked against V10's fact sheet (Engine v2 R16b, #3480, A1). `cargo run -p facts -- record <dir>
// <seconds>` writes a recording's bundles and, from the same effects, V4's public event index under `history/`;
// `facts sheet <dir> history 0 <seconds> <sheet>` reads the bundles into a sheet. Questions by place, thing and Soul,
// each asked of the index through R16's own `history` (client/src/history/history.mjs), must find the sheet's acts
// for it: the same count and kinds, and the same rows to the µs.
// Usage: node tools/facts/history.mjs <dir> <sheet> <seconds>. Prints one line per question; exits 1 on a difference.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFast, history, scan } from "../../client/src/history/history.mjs";

const [dir, sheetFile, seconds] = process.argv.slice(2);
const id = (v) => `${Buffer.from(v[0]).toString("hex")}-${v[1]}`;

// The sheet: each node's parent (as last listed) and every act, [µs, node, name].
const parents = new Map();
const rooms = new Set();
const acts = [];
const bytes = readFileSync(sheetFile);
for (let at = 0, first = true; at < bytes.length; first = false) {
  const len = bytes.readUInt32BE(at);
  const r = decodeFast(new Uint8Array(bytes.buffer, bytes.byteOffset + at + 4, len));
  at += 4 + len;
  if (first) continue; // the sheet's own record: format and span
  for (const [n, node] of r.get(2) ?? []) {
    parents.set(id(n), node.get(2) ? id(node.get(2)) : null);
    if (String(node.get(1)).startsWith("souls:room@")) rooms.add(id(n));
  }
  for (const [t, node, name] of r.get(6) ?? []) acts.push({ at: t, node: id(node), kind: name });
}
const under = (node, place) => {
  for (let n = node; n; n = parents.get(n)) if (n === place) return true;
  return false;
};

// The copy `history` names nodes and places from: the same parents.
const rows = new Map([...parents].map(([n, parent]) => [n, { id: n, parent }]));
const get = async (key) => {
  try {
    return new Uint8Array(readFileSync(join(dir, key)));
  } catch {
    return null;
  }
};
// The sheet holds acts in ((s - 1) s, s s] for its seconds: ask up to its last second.
const until = (Number(seconds) - 1) * 1e6;
const speaker = acts[0]?.node;
// And a room where nothing was said: nothing found.
const quiet = [...rooms].find((n) => !acts.some((a) => under(a.node, n)));
// The script's acts are said by the Soul whose body they are on (its actor), so a Soul's acts are its body's.
const questions = [
  ["place", parents.get(speaker), (a) => under(a.node, parents.get(speaker))],
  ["thing", speaker, (a) => a.node === speaker],
  ["soul", speaker, (a) => a.node === speaker],
  ["place", quiet, (a) => under(a.node, quiet)],
];

let failed = acts.length === 0;
if (failed) console.log("no acts on the sheet");
for (const [by, asked, takes] of questions) {
  const want = acts.filter((a) => a.at <= until && takes(a));
  const answer = await history({ by, id: asked, since: 0, until }, { get, rows });
  const nodes = by === "place" ? new Set([...parents.keys()].filter((n) => under(n, asked))) : new Set([asked]);
  const { found } = await scan(get, 0, until, (node, actor) => nodes.has(id(node)) || (by === "soul" && actor[0] === 1 && id(actor[1]) === asked));
  const kinds = {};
  for (const a of want) kinds[a.kind.replace(/^souls:/, "")] = (kinds[a.kind.replace(/^souls:/, "")] ?? 0) + 1;
  const same =
    answer.found === want.length &&
    JSON.stringify(answer.kinds) === JSON.stringify(kinds) &&
    JSON.stringify(found.map((f) => [f.at, f.node, f.kind])) === JSON.stringify(want.map((a) => [a.at, a.node, a.kind]));
  console.log(`${by} ${asked}: history found ${answer.found} ${JSON.stringify(answer.kinds)}, sheet ${want.length} ${JSON.stringify(kinds)}: ${same ? "same" : "DIFFERENT"}`);
  failed ||= !same;
}
process.exit(failed ? 1 : 0);
