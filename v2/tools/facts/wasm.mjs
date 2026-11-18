// The fact sheet in WASM (Engine v2 V10, #2720, A3): the recording `cargo run -p facts -- vectors <dir>` wrote is fed,
// file by file, to the WASM build's FactSheet in Node, and its sheets and factsAt records must be the native bytes.
// Usage: node tools/facts/wasm.mjs <wasm-bindgen pkg dir> <vectors dir>
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [pkg, dir] = process.argv.slice(2);
const r = await import(pathToFileURL(join(pkg, "replica.js")).href);
r.initSync({ module: readFileSync(join(pkg, "replica_bg.wasm")) });

// The stream's folder is the one holding the pointer.
function streamDir(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (e === "pointer") return d;
    if (statSync(p).isDirectory()) {
      const found = streamDir(p);
      if (found) return found;
    }
  }
  return null;
}

const header = readFileSync(join(dir, "header"));
const live = streamDir(join(dir, "www"));
const parts = [];
for (let n = 0; ; n++) {
  try {
    parts.push(readFileSync(join(live, String(n))));
  } catch {
    break;
  }
}
const bundles = readdirSync(join(dir, "bundles")).sort().map((b) => readFileSync(join(dir, "bundles", b)));

let failed = false;
for (const [name, files, feed] of [
  ["live", parts, "part"],
  ["history", bundles, "bundle"],
]) {
  const s = new r.FactSheet(header, 0n, 20n);
  for (const f of files) s[feed](f);
  const at = Buffer.from(s.factsAt(15_500_000n));
  const sheet = Buffer.from(s.finish());
  const wantSheet = readFileSync(join(dir, `${name}.sheet`));
  const wantAt = readFileSync(join(dir, `${name}.facts-at`));
  const same = sheet.equals(wantSheet) && at.equals(wantAt);
  console.log(
    `facts-wasm ${name}: ${files.length} files, sheet ${sheet.length} bytes, factsAt ${at.length} bytes, ` +
      `WASM in Node ${process.version} ${same ? "equal to" : "DIFFERENT from"} native`,
  );
  failed ||= !same;
}
if (failed) process.exit(1);
