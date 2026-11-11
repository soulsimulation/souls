#!/usr/bin/env node
// The Soul client's version and hashes are stamped once per release, by the release owner (#1935). A client pull request
// edits eden.mjs or skill.md and nothing else; this sets VERSION in eden.mjs, the skill's version lines and SOURCES.json
// (the client's version, and the hash of every listed file) in one run. `--check` changes nothing and exits non-zero when
// anything disagrees; the release gate runs it against the candidate.
//   node tools/world-launcher/soul/stamp.mjs <version>
//   node tools/world-launcher/soul/stamp.mjs --check
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newerThan } from "./home.mjs";

const DIR = fileURLToPath(new URL("./", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CLI_LINE = /^const VERSION = "([0-9.]+)";$/m, SKILL_META = /^  version: "([0-9.]+)"$/m, SKILL_TITLE = /^# Soul — skill ([0-9.]+)$/m;
const VERSION = /^[0-9]+(\.[0-9]+)*$/;

/** Every file SOURCES.json pins by hash, as [path in the soul folder, its record]. The legacy guides are history, not files here. */
export function listed(sources) {
  const files = Object.values(sources).filter((e) => e && typeof e.file === "string" && typeof e.sha256 === "string").map((e) => [e.file, e]);
  for (const a of sources.runtime?.artifacts ?? []) files.push([`${sources.runtime.directory}/${a.file}`, a]);
  return files;
}

/** What disagrees, given read(path in the soul folder) -> bytes or null. Empty when the client is stamped. */
export function problems(read) {
  const text = (p) => read(p)?.toString("utf8") ?? "", sources = JSON.parse(text("SOURCES.json")), skill = text("skill.md");
  const stated = { "eden.mjs VERSION": CLI_LINE.exec(text("eden.mjs"))?.[1], "skill.md version": SKILL_META.exec(skill)?.[1], "skill.md title": SKILL_TITLE.exec(skill)?.[1],
    "SOURCES.json controllerCli.version": sources.controllerCli?.version, "SOURCES.json skill.version": sources.skill?.version };
  const out = [], version = stated["eden.mjs VERSION"];
  for (const [where, v] of Object.entries(stated)) if (!v || v !== version) out.push(`${where} is ${v ?? "missing"}, eden.mjs says ${version ?? "nothing"}`);
  for (const [path, e] of listed(sources)) {
    const bytes = read(path);
    if (!bytes) out.push(`${path} is listed but missing`);
    else if (sha(bytes) !== e.sha256 || (e.bytes !== undefined && e.bytes !== bytes.length)) out.push(`${path} does not hash to SOURCES.json`);
  }
  return out;
}

/** Stamp `version` into the client in `dir`. Refuses a malformed version, and one not above the current when the client changed. */
export function stamp(version, dir = DIR) {
  if (!VERSION.test(String(version))) throw Error(`a version is digits and dots: ${version}`);
  const at = (p) => dir + p, sources = JSON.parse(readFileSync(at("SOURCES.json"), "utf8"));
  const cli = readFileSync(at("eden.mjs"), "utf8"), skill = readFileSync(at("skill.md"), "utf8"), current = CLI_LINE.exec(cli)?.[1];
  if (!current || !SKILL_META.test(skill) || !SKILL_TITLE.test(skill)) throw Error("eden.mjs or skill.md has no version line to stamp");
  const changed = sha(cli) !== sources.controllerCli.sha256 || sha(skill) !== sources.skill.sha256;
  if (changed && !newerThan(version, current)) throw Error(`the client changed since ${current}; stamp a version above it`);
  writeFileSync(at("eden.mjs"), cli.replace(CLI_LINE, `const VERSION = "${version}";`));
  writeFileSync(at("skill.md"), skill.replace(SKILL_META, `  version: "${version}"`).replace(SKILL_TITLE, `# Soul — skill ${version}`));
  sources.controllerCli.version = sources.skill.version = version;
  for (const [path, e] of listed(sources)) { const bytes = readFileSync(at(path)); e.sha256 = sha(bytes); if (e.bytes !== undefined) e.bytes = bytes.length; }
  writeFileSync(at("SOURCES.json"), JSON.stringify(sources, null, 2) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const arg = process.argv[2];
  if (!arg || process.argv.length > 3) { console.error("usage: stamp.mjs <version> | --check"); process.exit(2); }
  if (arg === "--check") {
    const off = problems((p) => { try { return readFileSync(DIR + p); } catch { return null; } });
    for (const p of off) console.error(p);
    console.log(off.length ? `client stamp: ${off.length} disagreement(s); the release owner runs stamp.mjs <version>` : "client stamp: consistent");
    process.exit(off.length ? 1 : 0);
  }
  try { stamp(arg); console.log(`client stamped ${arg}`); } catch (e) { console.error(e.message); process.exit(1); }
}
