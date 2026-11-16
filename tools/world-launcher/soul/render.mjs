// #2260: `shoot` renders a view of the public world on the owner's machine with the site's own viewer, in a headless
// browser here (Playwright), never the world's. It opens the world page anonymously (no token, no sign-in, no cookies),
// so it sees what any visitor sees. The browser profile under the home keeps the CDN's assets cached between shots.
// `view` stays the Soul's own eyes, rendered by the world; it is the fallback when this machine has no browser.
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";

export const SHOOT_KINDS = ["page", "broadcast", "follow", "eyes", "map", "free"];
export const SHOOT_USAGE = "usage: shoot [page|broadcast|follow <soul>|eyes <soul>|map [soul|place]|free] [--at x,y,z --look x,y,z | --from <place|soul|thing>] [--span m] [--clip s] [--size WxH] [--out file.png|.jpg|.mp4]";
export const NO_BROWSER = "No headless browser on this machine, so shoot cannot render here. Install one with `npm i -g playwright && npx playwright install chromium` (or set SOUL_PLAYWRIGHT to a folder whose node_modules has playwright), or use `view`, which the world renders: your Soul's own eyes.";
const CANVAS = 'canvas[aria-label="Live 3D view of the world"]';

const triple = (s, flag) => {
  const v = String(s ?? "").split(",").map(Number);
  if (v.length !== 3 || !v.every(Number.isFinite)) throw new Error(`${flag} needs x,y,z`);
  return v;
};

/** Arguments → what to shoot. Throws the usage on anything it does not know. */
export function parseShootArgs(args) {
  const o = { kind: null, subject: null, at: null, look: null, from: null, span: null, clip: 0, size: [1280, 720], out: null };
  const need = (i, flag) => { const v = args[i + 1]; if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value. ${SHOOT_USAGE}`); return v; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--at") o.at = triple(need(i, a), a), i++;
    else if (a === "--look") o.look = triple(need(i, a), a), i++;
    else if (a === "--from") o.from = need(i, a), i++;
    else if (a === "--out") o.out = need(i, a), i++;
    else if (a === "--span") { o.span = Number(need(i, a)); i++; if (!(o.span >= 2 && o.span <= 500)) throw new Error("--span is metres across, 2 to 500"); }
    else if (a === "--clip") { o.clip = Number(need(i, a)); i++; if (!(o.clip >= 1 && o.clip <= 30)) throw new Error("--clip is seconds, 1 to 30"); }
    else if (a === "--size") { const m = /^(\d{2,4})x(\d{2,4})$/.exec(need(i, a)); i++; if (!m || +m[1] < 64 || +m[2] < 64 || +m[1] > 1920 || +m[2] > 1920) throw new Error("--size is WxH, 64 to 1920"); o.size = [+m[1], +m[2]]; }
    else if (a.startsWith("--")) throw new Error(`Unknown shoot option ${a}. ${SHOOT_USAGE}`);
    else if (!o.kind && SHOOT_KINDS.includes(a)) o.kind = a;
    else if (o.subject === null && ["follow", "eyes", "map"].includes(o.kind)) o.subject = a;
    else throw new Error(SHOOT_USAGE);
  }
  o.kind ??= o.at || o.from ? "free" : "page";
  if ((o.kind === "follow" || o.kind === "eyes") && !o.subject) throw new Error(`shoot ${o.kind} needs a Soul's name`);
  if (o.kind === "free" && !(o.from || (o.at && o.look))) throw new Error("shoot free needs --at x,y,z --look x,y,z, or --from <place|soul|thing>");
  if (o.kind !== "free" && (o.at || o.from)) throw new Error("--at and --from place a free camera: shoot free …");
  if (o.span !== null && o.kind !== "map") throw new Error("--span is for map");
  o.out ??= `${o.kind}.${o.clip ? "mp4" : "png"}`;
  const ext = extname(o.out).toLowerCase();
  if (o.clip ? ext !== ".mp4" : ![".png", ".jpg", ".jpeg"].includes(ext)) throw new Error(o.clip ? "a clip is written as .mp4" : "a still is written as .png or .jpg");
  return o;
}

/** Playwright from the first of these folders that has it (SOUL_PLAYWRIGHT, the working folder, the home), else the global npm folder; null when none. */
export function findPlaywright(roots) {
  for (const root of roots.filter(Boolean)) for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
    try { return createRequire(join(resolve(root), "noop.js"))(name); } catch { /* not here */ }
  }
  return null;
}
function globalNodeModules() { try { return execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }
export function hasFfmpeg() { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; } }

/** Engine yaw 0 faces +x; forward is (cos yaw, sin yaw) on x/z. */
export function poseLooking(at, look, w, h, hfovDeg = 70) {
  const dx = look[0] - at[0], dy = look[1] - at[1], dz = look[2] - at[2];
  return { p: at, yaw: Math.atan2(dz, dx), pitch: Math.atan2(dy, Math.max(1e-6, Math.hypot(dx, dz))), vfov: 2 * Math.atan(Math.tan(hfovDeg * Math.PI / 360) * h / w) };
}
const norm = (s) => String(s).trim().toLowerCase();
/** A name in the page's public replica: a Soul (by name), a place (by label) or a thing (by entity id), in that order. */
export function resolveName(where, name) {
  const n = norm(name), pick = (list, key) => list.find((x) => norm(x[key]) === n) ?? list.find((x) => norm(x[key]).includes(n));
  const soul = pick(where.souls, "name"); if (soul) return { kind: "soul", ...soul };
  const place = pick(where.places, "name"); if (place) return { kind: "place", ...place };
  const thing = pick(where.things, "id"); if (thing) return { kind: "thing", ...thing };
  return null;
}
/** The eyes-mode job for a free camera, another Soul's eyes or the overhead map (WorldEyes.ts), from the replica now. */
export function eyesJob(o, where) {
  const [w, h] = o.size, all = where.souls.map((s) => s.entityId);
  const named = (name) => { const r = resolveName(where, name); if (!r) throw new Error(`No Soul, place or thing called "${name}" in this world's public view`); return r; };
  if (o.kind === "eyes") {
    const s = where.souls.find((x) => norm(x.name) === norm(o.subject)) ?? where.souls.find((x) => norm(x.name).includes(norm(o.subject)));
    if (!s) throw new Error(`No Soul called "${o.subject}" is in the world now`);
    return { mode: "eyes", w, h, quality: 0.9, pose: { p: [s.p[0], s.p[1] + 1.6, s.p[2]], yaw: s.yaw, pitch: -0.06, vfov: 2 * Math.atan(Math.tan(Math.PI / 4) * h / w) }, self: s.entityId, show: all.filter((id) => id !== s.entityId), subject: s.name };
  }
  if (o.kind === "map") {
    let c, span = o.span, soul = null;
    if (o.subject) { const r = named(o.subject); c = r.kind === "place" ? r.target : r.p; span ??= 40; if (r.kind === "soul") soul = r; }
    else {
      const ps = where.souls.length ? where.souls.map((s) => s.p) : where.things.map((t) => t.p);
      if (!ps.length) throw new Error("Nothing is drawn yet to centre a map on; name a place");
      const lo = [0, 1, 2].map((i) => Math.min(...ps.map((p) => p[i]))), hi = [0, 1, 2].map((i) => Math.max(...ps.map((p) => p[i])));
      c = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]; span ??= Math.min(500, Math.max(30, Math.max(hi[0] - lo[0], hi[2] - lo[2]) + 16));
    }
    return { mode: "map", w, h, quality: 0.9, pose: { p: [c[0], c[1], c[2]], yaw: soul ? soul.yaw : -Math.PI / 2, pitch: 0, vfov: 1 }, self: "", show: all, span: span / 2, marker: !!soul, subject: o.subject ?? "everyone" };
  }
  // free: --at/--look, or --from a named spot (a place's own view; 5 m back and 2.5 m up from a Soul or thing), --look aims it
  let at = o.at, look = o.look, subject = o.at ? `${o.at.join(",")}` : o.from;
  if (o.from) {
    const r = named(o.from); subject = `${r.kind} ${r.name ?? r.id}`;
    if (r.kind === "place") { at = [...r.p]; look ??= [...r.target]; }
    else { const t = [r.p[0], r.p[1] + (r.kind === "soul" ? 1.3 : 0.8), r.p[2]], back = r.kind === "soul" ? r.yaw + Math.PI : Math.PI / 4; at = [t[0] + Math.cos(back) * 5, t[1] + 2.5, t[2] + Math.sin(back) * 5]; look ??= t; }
  }
  return { mode: "eyes", w, h, quality: 0.9, pose: poseLooking(at, look, w, h), self: "", show: all, subject };
}

async function launch(pw, profile, o, video) {
  const tries = [{ channel: "chromium" }, {}, { channel: "chrome" }], gpu = [["--ignore-gpu-blocklist"], ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]];
  let last = null;
  for (const t of tries) for (const args of gpu) {
    let ctx = null;
    try {
      ctx = await pw.chromium.launchPersistentContext(profile, { headless: true, ...t, args: [...args, "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
        viewport: { width: o.size[0], height: o.size[1] }, deviceScaleFactor: 1, reducedMotion: "reduce", ...(video ? { recordVideo: { dir: video, size: { width: o.size[0], height: o.size[1] } } } : {}) });
      const page = ctx.pages()[0] ?? await ctx.newPage();
      const gl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
      if (gl) { await ctx.clearCookies(); return { ctx, page }; }
      last = "no WebGL"; await ctx.close();
    } catch (e) { last = String(e.message).split("\n")[0]; try { await ctx?.close(); } catch { /* gone */ } if (/Executable doesn't exist|browserType\.launch|Failed to launch/i.test(last) && t.channel) break; }
  }
  const err = new Error(`${NO_BROWSER} (${/lock|in use|SingletonLock/i.test(last ?? "") ? "the shoot profile is in use by another shoot" : last})`); err.noBrowser = true; throw err;
}

function encode(frames, fps, out) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", out], { stdio: ["pipe", "ignore", "pipe"] });
    let err = ""; ff.stderr.on("data", (d) => { err += d; });
    ff.on("error", reject); ff.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg: " + err.trim().slice(0, 300)))));
    for (const f of frames) ff.stdin.write(f);
    ff.stdin.end();
  });
}
function trim(src, from, seconds, out) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", from.toFixed(2), "-i", src, "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
}

/** Shoot one view of `world` (its page URL, …/w/<slug>) into `out` (an absolute path). Returns what was written. */
export async function shoot(o, { world, out, profile, roots = [], timeoutMs = 180_000 }) {
  if (o.clip && !hasFfmpeg()) throw new Error("A clip needs ffmpeg on this machine (a still needs only the browser); or use `view`, which the world renders");
  const pw = findPlaywright([...roots, globalNodeModules()]);
  if (!pw) { const e = new Error(NO_BROWSER); e.noBrowser = true; throw e; }
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const page_ = ["page", "broadcast", "follow"].includes(o.kind), video = page_ && o.clip ? mkdtempSync(join(tmpdir(), "soul-shoot-")) : null;
  const t0 = performance.now(), { ctx, page } = await launch(pw, profile, o, video), opened = performance.now();
  // bytes over the network (a response from the profile's cache counts nothing): the first shot fetches the assets, later ones reuse them
  let bytes = 0, requests = 0; const sizing = [];
  page.on("requestfinished", (r) => { requests++; sizing.push(r.sizes().then((s) => { bytes += (s.responseBodySize || 0) + (s.responseHeadersSize || 0); }, () => {})); });
  try {
    const base = world.replace(/\/+$/, "") + "/", url = base + "?" + (page_ ? "render=1" : "eyes=1&render=1");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    let subject = o.kind === "page" ? "the world page" : o.kind === "broadcast" ? "the broadcast camera" : o.subject;
    if (page_) {
      await page.waitForFunction(() => !!document.body && !document.querySelector(".viewer-arrival") && !!document.querySelector('.viewer-history[data-viewer-ready="true"]'), null, { timeout: timeoutMs, polling: 250 });
      if (o.kind === "follow") {
        const s = await page.evaluate((name) => { const n = name.toLowerCase(), all = window.edenWhere?.().souls ?? []; return all.find((x) => x.name.toLowerCase() === n) ?? all.find((x) => x.name.toLowerCase().includes(n)) ?? null; }, o.subject);
        if (!s) throw new Error(`No Soul called "${o.subject}" is in the world now`);
        subject = s.name;
        await page.evaluate((id) => window.dispatchEvent(new CustomEvent("sim:follow-soul", { detail: { soulId: id } })), s.id);   // the page's own Follow (follow-soul-request.ts)
        await page.waitForFunction(() => document.querySelector(".viewer-history")?.dataset.viewerMode === "follow", null, { timeout: 15_000 });
      }
      // broadcast and follow show the 3D view alone: the canvas over the page's panels
      if (o.kind !== "page") await page.addStyleTag({ content: `${CANVAS}{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important}` });
      await page.waitForTimeout(o.kind === "page" ? 1500 : 2500);   // the camera settles on its shot
      const ready = performance.now();
      if (!o.clip) {
        const type = /\.png$/i.test(out) ? "png" : "jpeg";
        const buf = o.kind === "page" ? await page.screenshot({ type, ...(type === "jpeg" ? { quality: 90 } : {}) }) : await page.locator(CANVAS).screenshot({ type, ...(type === "jpeg" ? { quality: 90 } : {}) });
        writeFileSync(out, buf);
      } else {
        await page.waitForTimeout(o.clip * 1000 + 300);
        const v = page.video(); await ctx.close(); const src = await v.path();
        trim(src, (ready - opened) / 1000, o.clip, out);
      }
    } else {
      await page.waitForFunction(() => window.edenEyes?.ready?.() === true, null, { timeout: timeoutMs, polling: 250 });
      const where = () => page.evaluate(() => window.edenEyes.where());
      const shot = async (job) => { const r = await page.evaluate((j) => window.edenEyes.capture(j), job); if (!r?.ok) throw new Error(`render failed: ${r?.error ?? "no frame"}`); return Buffer.from(r.b64, "base64"); };
      let job = eyesJob(o, await where()); subject = job.subject; delete job.subject;
      await shot({ ...job, w: 320, h: 180, quality: 0.5 });   // the first frame compiles the scene's shaders (seconds); a clip starts after it
      if (!o.clip) {
        let buf = await shot(job);
        if (/\.png$/i.test(out)) buf = Buffer.from(await page.evaluate(async (b64) => { const img = new Image(); img.src = "data:image/jpeg;base64," + b64; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; c.getContext("2d").drawImage(img, 0, 0); return c.toDataURL("image/png").slice(22); }, buf.toString("base64")), "base64");
        writeFileSync(out, buf);
      } else {
        // frames back to back for --clip seconds, the camera re-placed from the replica each frame (a moving Soul is kept)
        const frames = [], start = performance.now();
        while (performance.now() - start < o.clip * 1000) {
          if (frames.length && o.kind !== "free") { const j = eyesJob(o, await where()); delete j.subject; job = j; }
          frames.push(await shot(job));
        }
        const fps = (frames.length / ((performance.now() - start) / 1000)).toFixed(3);   // real speed: the rate the frames were made at
        await encode(frames, fps, out);
      }
    }
    return { kind: o.kind, of: subject, saved: out, size: `${o.size[0]}x${o.size[1]}`, ...(o.clip ? { seconds: o.clip } : {}), ms: Math.round(performance.now() - t0),
      requests, downloadedKB: await Promise.all(sizing).then(() => Math.round(bytes / 1024)), seenAs: "an anonymous visitor (no token, no sign-in)", renderedBy: "this machine's browser, with the site's own viewer" };
  } finally {
    try { await ctx.close(); } catch { /* closed */ }
    if (video) try { rmSync(video, { recursive: true, force: true }); } catch { /* left in tmp */ }
  }
}

/** The shoot profile folder (the browser's cache of the site's assets) under a home. */
export const shootProfile = (root) => join(root, "cache", "shoot-browser");
