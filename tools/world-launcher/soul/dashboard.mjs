// dashboard.mjs: a Soul's local dashboard (#2248). One read-only page on the owner's machine and the one endpoint behind it,
// `/data.json` (`dashboard-data/1`, docs/architecture/souls.md). It reads the Soul's own `runtime/` and `memory/` folders and
// what eden.mjs hands it; it sends nothing to any world, makes no model call, and no route changes anything.
//
// Edit this file, then run `node tools/world-launcher/soul/inline.mjs`: worlds serve eden.mjs as one file, so this module
// lives inside it as a generated block.

import { createServer } from "node:http";
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { resolve } from "node:path";

export const DASHBOARD_DATA = "dashboard-data/1";
const DAY = /^\d{4}-\d{2}-\d{2}$/, LOG_LINES = 200, FILE_MAX = 1 << 20, LOG_WINDOW = 256 * 1024;

/** `name` inside `root` as a plain file no link reaches, or null: nothing outside the folder can be named. */
function safeFile(root, name) {
  root = resolve(root);
  const path = resolve(root, name);
  if (!path.startsWith(root + "/")) return null;
  try {
    const f = lstatSync(path);   // lstat: a link is not a file here, and a hard link shows as a second name
    if (!f.isFile() || f.nlink !== 1) return null;
    for (let p = resolve(path, ".."); p.length >= root.length; p = resolve(p, "..")) if (lstatSync(p).isSymbolicLink()) return null;
  } catch { return null; }
  return path;
}
/** The file's text, at most FILE_MAX bytes; `tail` reads its last LOG_WINDOW bytes from the start of a line. null when there is none. */
function readText(root, name, { tail = false } = {}) {
  const path = safeFile(root, name);
  if (!path) return null;
  const size = lstatSync(path).size, max = tail ? LOG_WINDOW : FILE_MAX, from = tail ? Math.max(0, size - max) : 0, b = Buffer.alloc(Math.min(max, size - from));
  const fd = openSync(path, "r");
  try { readSync(fd, b, 0, b.length, from); } finally { closeSync(fd); }
  const text = b.toString("utf8");
  return tail && from > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}
const list = (root, dir, pattern) => { const at = safeDir(root, dir); if (!at) return null; try { return readdirSync(at).filter((n) => pattern.test(n)).sort(); } catch { return null; } };
const isDir = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
function safeDir(root, dir) {
  root = resolve(root);
  const path = resolve(root, dir);
  if (!path.startsWith(root + "/")) return null;
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink() ? path : null; } catch { return null; }
}
/** The lines under `## heading` up to the next heading of that level or higher, as text; null when the file or heading is missing. */
function section(text, heading) {
  if (text == null) return null;
  const lines = text.split("\n"), start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).trim() === heading);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}
/** A journal day's page, or null. */
export function journalDay(dirs, day) { return DAY.test(day ?? "") ? readText(dirs.memory, `journal/${day}.md`) : null; }

/** Everything the page shows. `ask()` is eden.mjs's local read of status, resident, plan and wakes; each part it cannot give is null. */
export async function dashboardData(dirs, ask, at = new Date()) {
  let local = {};
  try { local = (await ask()) ?? {}; } catch { /* the parts it gives stay null */ }
  const today = at.toISOString().slice(0, 10), days = list(dirs.memory, "journal", /^\d{4}-\d{2}-\d{2}\.md$/);
  const people = list(dirs.memory, "people", /^[^.].*\.md$/);
  const log = readText(dirs.runtime, ".eden-serve.log", { tail: true });
  return {
    version: DASHBOARD_DATA, at: at.toISOString(),
    status: local.status ?? null, resident: local.resident ?? null, plan: local.plan ?? null, wakes: local.wakes ?? null,
    journal: days ? { today, page: journalDay(dirs, today), days: days.map((n) => n.slice(0, 10)).reverse() } : null,
    memory: !isDir(dirs.memory) ? null : {
      self: readText(dirs.memory, "self.md"), goals: readText(dirs.memory, "goals.md"), lessons: readText(dirs.memory, "lessons.md"),
      people: people ? people.map((n) => /^# (.+?)(?: \[[^\]]*\])?\s*$/.exec(readText(dirs.memory, `people/${n}`)?.split("\n")[0] ?? "")?.[1] ?? n.replace(/\.md$/, "")) : null,
    },
    cost: section(readText(dirs.memory, "ledger.md"), "Observed budget by UTC day"),
    log: log == null ? null : log.split("\n").filter(Boolean).slice(-LOG_LINES),
  };
}

/** Every secret out of a text: the exact values eden.mjs names (each token and poll secret in credentials.json) and any bearer header. */
export function scrub(text, secrets = []) {
  let out = String(text).replace(/\bBearer\s+[^\s"'\\]+/gi, "Bearer [redacted]");
  for (const s of secrets) if (typeof s === "string" && s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}
const deepScrub = (v, secrets) => (typeof v === "string" ? scrub(v, secrets) : Array.isArray(v) ? v.map((x) => deepScrub(x, secrets))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepScrub(x, secrets)])) : v);

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Serve the page and its data on 127.0.0.1 until closed. `page()` returns the HTML each time, so an owner's file is read fresh. */
export async function startDashboard({ dirs, ask, port = 0, page = () => PAGE, secrets = () => [] }) {
  let host = null;
  const server = createServer(async (req, res) => {
    const send = (status, type, body) => {
      const text = scrub(body, secrets());
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": CSP, ...(status === 405 ? { allow: "GET, HEAD" } : {}) });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    const json = (status, data) => send(status, "application/json; charset=utf-8", JSON.stringify(deepScrub(data, secrets())));
    try {
      // Only this machine, at this address: a page of another site, or a name rebound to 127.0.0.1, gets nothing.
      if (req.headers.host !== host || req.headers["sec-fetch-site"] === "cross-site") return json(403, { error: "This dashboard answers only its own address on this machine." });
      if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "This dashboard is read-only." });
      const path = new URL(req.url, `http://${host}`).pathname;
      if (path === "/" || path === "/index.html") return send(200, "text/html; charset=utf-8", page());
      if (path === "/data.json") return json(200, await dashboardData(dirs, ask));
      const day = /^\/journal\/([^/]+)$/.exec(path)?.[1], text = day ? journalDay(dirs, day) : null;
      if (text != null) return send(200, "text/markdown; charset=utf-8", text);
      return json(404, { error: "not found" });
    } catch { return json(500, { error: "The dashboard could not read this; the Soul's files are unchanged." }); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  await new Promise((done, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", done); });
  host = `127.0.0.1:${server.address().port}`;
  return { url: `http://${host}/`, port: server.address().port, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }) };
}

/** The built-in page: one file, plain HTML and script, system fonts, no request but to this server. `dashboard --template` prints it. */
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Soul dashboard</title>
<style>
:root { color-scheme: light dark; --bg: #f6f4ee; --fg: #1f2a24; --mute: #6b746e; --card: #ffffff; --line: #ddd8cc; --ok: #2f7d4f; --off: #a0522d; }
@media (prefers-color-scheme: dark) { :root { --bg: #161a18; --fg: #e6e9e4; --mute: #98a19b; --card: #1f2421; --line: #333a36; --ok: #6cc28f; --off: #e0a07a; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header, main { max-width: 980px; margin: 0 auto; padding: 16px; }
header h1 { margin: 0; font-size: 1.5em; } header p { margin: 4px 0 0; color: var(--mute); }
main { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; min-width: 0; }
section.wide { grid-column: 1 / -1; }
h2 { margin: 0 0 8px; font-size: 1em; text-transform: uppercase; letter-spacing: .04em; color: var(--mute); }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace; max-height: 420px; overflow: auto; }
dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; } dt { color: var(--mute); } dd { margin: 0; overflow-wrap: anywhere; }
.up { color: var(--ok); } .down { color: var(--off); } .none { color: var(--mute); font-style: italic; }
button { font: inherit; margin: 0 6px 6px 0; padding: 2px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--fg); cursor: pointer; }
button[aria-pressed="true"] { border-color: var(--fg); }
</style></head>
<body>
<header><h1 id="name">Soul</h1><p id="state">Reading this machine…</p></header>
<main>
<section><h2>Status</h2><div id="status"></div></section>
<section><h2>Resident</h2><div id="resident"></div></section>
<section><h2>Plan</h2><div id="plan"></div></section>
<section><h2>Wakes</h2><div id="wakes"></div></section>
<section class="wide"><h2>Journal</h2><div id="days"></div><pre id="journal"></pre></section>
<section><h2>Self</h2><pre id="self"></pre></section>
<section><h2>Goals</h2><pre id="goals"></pre></section>
<section><h2>Lessons</h2><pre id="lessons"></pre></section>
<section><h2>People</h2><div id="people"></div></section>
<section class="wide"><h2>Cost</h2><pre id="cost"></pre></section>
<section class="wide"><h2>Resident log, last 200 lines</h2><pre id="log"></pre></section>
</main>
<script>
// Every value here comes from /data.json and is shown as text, never as markup: worlds and other Souls wrote much of it.
var el = function (id) { return document.getElementById(id); };
var day = null, lastDays = "";
function none(text) { var s = document.createElement("span"); s.className = "none"; s.textContent = text || "not yet"; return s; }
function show(id, value) {
  var box = el(id); box.replaceChildren();
  if (value === null || value === undefined || value === "") return box.append(none());
  if (typeof value !== "object") return box.append(String(value));
  var dl = document.createElement("dl");
  Object.keys(value).forEach(function (k) {
    var dt = document.createElement("dt"), dd = document.createElement("dd"), v = value[k];
    dt.textContent = k; dd.textContent = v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
    dl.append(dt, dd);
  });
  box.append(dl);
}
function text(id, value) { var box = el(id); box.replaceChildren(value ? document.createTextNode(value) : none()); }
function pick(d) {
  day = d; Array.prototype.forEach.call(el("days").children, function (b) { b.setAttribute("aria-pressed", String(b.textContent === d)); });
  fetch("/journal/" + d).then(function (r) { return r.ok ? r.text() : ""; }).then(function (t) { text("journal", t); });
}
function render(d) {
  var s = d.status || {}, r = d.resident;
  el("name").textContent = (s.soul && (s.soul.name || s.soul.id)) || "Soul";
  el("state").textContent = (r && r.up ? "serve is running here" : "no serve here: showing what is on disk") + " · " + (s.world || "no world") + " · updated " + new Date(d.at).toLocaleTimeString();
  el("state").className = r && r.up ? "up" : "down";
  show("status", d.status); show("resident", d.resident); show("plan", d.plan); show("wakes", d.wakes);
  var j = d.journal, days = j ? j.days : [];
  if (days.join() !== lastDays) {
    lastDays = days.join(); el("days").replaceChildren();
    days.forEach(function (n) { var b = document.createElement("button"); b.textContent = n; b.onclick = function () { pick(n); }; el("days").append(b); });
    if (!days.length) el("days").append(none("no journal yet"));
  }
  if (!day || day === (j && j.today)) { if (j && j.page) { day = j.today; text("journal", j.page); } else if (!day && days.length) pick(days[0]); else if (!days.length) text("journal", null); }
  var m = d.memory || {};
  text("self", m.self); text("goals", m.goals); text("lessons", m.lessons);
  el("people").replaceChildren(m.people && m.people.length ? document.createTextNode(m.people.join(", ")) : none());
  text("cost", d.cost); text("log", d.log ? d.log.join("\\n") : null);
}
function tick() {
  fetch("/data.json", { cache: "no-store" }).then(function (r) { return r.json(); }).then(render)
    .catch(function () { el("state").textContent = "The dashboard has stopped; start it again with: node eden.mjs dashboard"; el("state").className = "down"; });
}
tick(); setInterval(tick, 5000);
</script>
</body></html>
`;
