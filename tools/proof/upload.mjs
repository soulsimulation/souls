#!/usr/bin/env node
// Hosts proof media (clips, images, logs, proof.json) for a PR, so the PR links it and the repo never stores it.
//
//   node tools/proof/upload.mjs --pr <n> [--proof <proof.json>] [--dry-run] [--json] [--no-preview] [--preview-start <s>]
//        [--preview-seconds <s>] <file>...
//
// Targets:
//   default   the proof CDN: the asset bucket behind cdn.soul.game, at `proofs/pr-<n>/<file>`, public at
//             https://cdn.soul.game/proofs/pr-<n>/<file> (PROOF_CDN). Uploads sign with the R2 credentials of
//             tools/cdn/publish.mjs: EDEN_ASSETS_CREDENTIALS, else the main checkout's
//             .local/project/team/secrets/soul-game-assets-r2.env, and SOULS_ASSETS_R2_ENDPOINT or CF_ACCOUNT_ID from the environment or the main
//             checkout's deploy.env. Without them the upload is blocked (exit 3): attach the clips to the PR by hand.
//             Proof never goes in GitHub Releases, which are for versions of the software.
//   SIM_PROOF_UPLOAD_URL (+ SIM_PROOF_UPLOAD_TOKEN)
//             any endpoint that takes `PUT <url>/pr-<n>/<file>` with `Authorization: Bearer <token>` and answers
//             with JSON `{ "url": ... }` or a Location header; otherwise the public link is
//             `${SIM_PROOF_PUBLIC_URL || SIM_PROOF_UPLOAD_URL}/pr-<n>/<file>`.
//
// An existing name is never overwritten: a re-take gets `-2`, `-3`, ... so earlier (failed) takes stay linkable.
// With --proof, a clip's uncut, realSpeed, seconds, viewport and caption come from its `<clip>.json` sidecar where proof.json
// leaves them unset; a clip whose uncut or realSpeed would stay unset is refused (proof.media-incomplete) before anything
// is uploaded. A clip whose sidecar records a privacy hit (clip-privacy.mjs) is refused (proof.clip-private) with or
// without --proof, and so is a sidecar itself, which holds local paths and stays unpublished.
// With --proof, clip and image urls are written into proof.json `media[]` and other files' (logs, JSON) into `files[]`,
// matched by file name (new media get an entry to complete). Then proof.json itself is uploaded last and its link
// printed: that is the link for the PR.
//
// Inline previews: GitHub plays only its own attachments inline, so a CDN mp4 link never plays in the PR. For each video,
// ffmpeg makes `<clip>.preview.gif` beside it (--preview-seconds, default 6, from --preview-start, default the clip's
// `arrived` mark in its `<clip>.json` sidecar, else 0, or 0 for a take recorded from load on purpose (#888);
// real speed, at most 5 MB, smaller frames until it fits), uploads it next to the clip and records it as proof.json
// `media[].preview`. The printed `[![...](preview.gif)](clip.mp4)` line embeds it in the PR, linked to the full clip.
// Without ffmpeg the clip is uploaded alone, with a warning. --no-preview skips it.
//
// When the upload is blocked (no R2 credentials, no permission, no network: always in cloud sessions) it exits 3
// and says so. Then tell the user where the files are and ask them to attach them; never commit media to get
// around it, and never push it to another branch.
import { isMain } from '../lib/is-main.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipPrivacyHits, hitSummary } from './clip-privacy.mjs';
import { PROOF_CDN } from './acceptance.mjs';
import { assertPublishable, readPublication } from './publication.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_BYTES = 2 * 1024 ** 3, WARN_BYTES = 100 * 1024 ** 2;
export const TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.json': 'application/json', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.html': 'text/html',
};
export const contentType = file => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
export const kindOf = file => /^video\//.test(contentType(file)) ? 'video' : /^image\//.test(contentType(file)) ? 'image' : 'file';

export class Blocked extends Error {}
/** A clip whose proof.json entry would fail `proof-ok`, refused before anything is uploaded. */
export class IncompleteMedia extends Error { code = 'proof.media-incomplete'; }
/** A clip that showed something private, or a sidecar, refused before anything is uploaded. */
export class PrivateClip extends Error { code = 'proof.clip-private'; }

export const safeName = s => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
export const logicalName = (pr, file) => `pr-${pr}/${safeName(basename(file))}`;

/** `name`, or `name-2.ext`, `name-3.ext`, ... the first one not in `taken`. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
}

/** Refuses media that is (or is about to be) committed; warns when it sits in the tree without being ignored. */
export function checkLocal(files, git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), root = ROOT) {
  const problems = [], warnings = [];
  for (const f of files) {
    if (!existsSync(f)) { problems.push(`${f}: no such file`); continue; }
    const size = statSync(f).size;
    if (size > MAX_BYTES) problems.push(`${f}: ${(size / 1024 ** 3).toFixed(1)} GiB is over the 2 GiB proof limit`);
    else if (size > WARN_BYTES) warnings.push(`${f}: ${(size / 1024 ** 2).toFixed(0)} MB; consider a shorter clip`);
    const rel = relative(root, resolve(f));
    if (rel.startsWith('..')) continue;
    let tracked = false, ignored = false;
    try { git('ls-files', '--error-unmatch', '--', rel); tracked = true; } catch { /* untracked */ }
    if (tracked) { problems.push(`${rel}: tracked by git; proof media must not be committed (git rm --cached, keep it under .e2e/)`); continue; }
    try { git('check-ignore', '-q', '--', rel); ignored = true; } catch { /* not ignored */ }
    if (!ignored) warnings.push(`${rel}: inside the repo and not gitignored; keep proof media under .e2e/ so it cannot be committed`);
  }
  return { problems, warnings };
}

// ── targets ─────────────────────────────────────────────────────────────────────────────────────────────────────
export { PROOF_CDN };
/** Repo-relative home of the R2 credential file in the main checkout (never committed: .local is ignored). */
export const CREDENTIALS_FILE = '.local/project/team/secrets/soul-game-assets-r2.env';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The main checkout, where a worktree's ignored .local and deploy.env live. */
function mainCheckout() {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return dirname(isAbsolute(common) ? common : resolve(ROOT, common));
  } catch { return ROOT; }
}

/**
 * Proof CDN target: PUT to `<bucket>/proofs/<pr-n>/<file>` on the R2 endpoint, public at `${publicUrl}/pr-<n>/<file>`.
 * `If-None-Match: *` never overwrites: a name already there (412) moves on to `-2`, `-3`, ... `sign({url, method,
 * credentials, body, headers})` returns the signed headers (publish.mjs sigv4Headers); injected in tests.
 */
export function cdnTarget({ credentials = null, endpoint = null, bucket = 'soul-game-assets', sign = null, fetchImpl = fetch, read = readFileSync, dryRun = false, publicUrl = PROOF_CDN }) {
  const taken = new Set(), pub = publicUrl.replace(/\/+$/, '');
  return {
    name: `the proof CDN (${new URL(pub).host})`,
    async upload(pr, file) {
      const name = uniqueName(logicalName(pr, file), taken);
      taken.add(name);
      if (dryRun) return { name, url: `${pub}/${name}`, dryRun: true };
      const url = new URL(`/${bucket}/proofs/${name}`, endpoint), body = read(file);
      const headers = sign({ url, method: 'PUT', credentials, body, headers: { 'content-type': contentType(file), 'cache-control': IMMUTABLE, 'if-none-match': '*' } });
      let res;
      try { res = await fetchImpl(url, { method: 'PUT', body, headers, redirect: 'error' }); } catch (e) { throw new Blocked(`PUT ${url.host}: ${e.message}`); }
      if (res.status === 412) return this.upload(pr, file);
      if ([401, 403].includes(res.status)) throw new Blocked(`PUT ${url.host}: HTTP ${res.status}: these R2 credentials cannot write proofs/`);
      if (!res.ok) throw Error(`PUT ${name}: HTTP ${res.status}`);
      return { name, url: `${pub}/${name}` };
    },
  };
}

/** The proof CDN with this machine's R2 credentials, or Blocked naming what is missing. */
export async function liveCdnTarget({ env = process.env, main = mainCheckout() } = {}) {
  const file = env.EDEN_ASSETS_CREDENTIALS || join(main, CREDENTIALS_FILE);
  if (!existsSync(file)) throw new Blocked(`no R2 credentials for the proof CDN (set EDEN_ASSETS_CREDENTIALS, or keep them at ${CREDENTIALS_FILE} in the main checkout)`);
  // publish.mjs reads CF_ACCOUNT_ID when it loads: point it at the main checkout's deploy.env from a worktree.
  if (!env.SIM_DEPLOY_ENV && existsSync(join(main, 'deploy.env'))) process.env.SIM_DEPLOY_ENV = join(main, 'deploy.env');
  const { BUCKET, ENDPOINT, loadCredentials, requireAccount, sigv4Headers } = await import('../cdn/publish.mjs');
  let credentials;
  try { requireAccount(); credentials = await loadCredentials(file); } catch (e) { throw new Blocked(`proof CDN: ${e.message}`); }
  return cdnTarget({ credentials, endpoint: ENDPOINT, bucket: BUCKET, sign: sigv4Headers });
}

/** Generic HTTP PUT target (SIM_PROOF_UPLOAD_URL). */
export function httpTarget({ url, token, publicUrl, fetchImpl = fetch, read = readFileSync, dryRun = false }) {
  const base = url.replace(/\/+$/, ''), pub = (publicUrl || url).replace(/\/+$/, '');
  const taken = new Set();
  return {
    name: `upload endpoint ${new URL(base).host}`,
    async upload(pr, file) {
      const name = uniqueName(logicalName(pr, file), taken);
      taken.add(name);
      if (dryRun) return { name, url: `${pub}/${name}`, dryRun: true };
      let res;
      try {
        res = await fetchImpl(`${base}/${name}`, { method: 'PUT', body: read(file), headers: { 'Content-Type': contentType(file), 'If-None-Match': '*', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      } catch (e) { throw new Blocked(`PUT ${new URL(base).host}: ${e.message}`); }
      if (res.status === 412) { taken.add(name); return this.upload(pr, file); }
      if ([401, 403, 404, 407].includes(res.status)) throw new Blocked(`PUT ${new URL(base).host}: HTTP ${res.status}`);
      if (!res.ok) throw Error(`PUT ${name}: HTTP ${res.status}`);
      let link = res.headers?.get?.('location');
      try { const j = await res.json(); if (j?.url) link = j.url; } catch { /* no JSON body */ }
      return { name, url: link || `${pub}/${name}` };
    },
  };
}

export async function pickTarget({ env = process.env, fetchImpl, dryRun = false, live = liveCdnTarget } = {}) {
  if (env.SIM_PROOF_UPLOAD_URL) return httpTarget({ url: env.SIM_PROOF_UPLOAD_URL, token: env.SIM_PROOF_UPLOAD_TOKEN, publicUrl: env.SIM_PROOF_PUBLIC_URL, fetchImpl, dryRun });
  return dryRun ? cdnTarget({ dryRun: true }) : live({ env });
}

// ── previews ────────────────────────────────────────────────────────────────────────────────────────────────────
export const PREVIEW_MAX_BYTES = 5 * 1024 ** 2;
/** Frame width and rate, largest first; the first that fits PREVIEW_MAX_BYTES wins. */
export const PREVIEW_LADDER = [{ width: 480, fps: 10 }, { width: 360, fps: 8 }, { width: 240, fps: 6 }];
export const previewPath = file => join(dirname(file), `${basename(file, extname(file))}.preview.gif`);

/** ffmpeg arguments for one animated GIF preview (palette per clip, loops forever, real speed). */
export function previewArgs({ input, output, start = 0, seconds = 6, width = 480, fps = 10 }) {
  return ['-y', '-v', 'error', '-ss', String(start), '-t', String(seconds), '-i', input,
    '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`,
    '-loop', '0', output];
}

/**
 * Makes the preview GIF for a video: { file, bytes, width, fps } or { skipped: reason }. `ffmpeg(args)` runs ffmpeg
 * and `size(path)` returns bytes; both injected in tests.
 */
export function makePreview(file, { start = 0, seconds = 6, ffmpeg = args => execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }), size = p => statSync(p).size } = {}) {
  const output = previewPath(file);
  for (const step of PREVIEW_LADDER) {
    try { ffmpeg(previewArgs({ input: file, output, start, seconds, ...step })); } catch (e) {
      return { skipped: e.code === 'ENOENT' ? 'ffmpeg is not installed' : `ffmpeg failed: ${String(e.stderr ?? e.message).trim().split('\n')[0]}` };
    }
    const bytes = size(output);
    if (bytes <= PREVIEW_MAX_BYTES) return { file: output, bytes, ...step };
  }
  return { skipped: `even a ${PREVIEW_LADDER.at(-1).width}px preview is over ${PREVIEW_MAX_BYTES / 1024 ** 2} MB; use --preview-seconds to shorten it` };
}

const SIDECAR = /\.(?:mp4|m4v|webm|mov)\.json$/i;
/** A clip's sidecar (`<clip>.json`, written by record.mjs and the run cameras), or null. */
export function clipSidecar(file, read = readFileSync) { try { return JSON.parse(read(`${file}.json`, 'utf8')); } catch { return null; } }

/** Where a clip's inline preview starts (#888): its `arrived` mark (the world on screen), unless the take was recorded
 *  from load on purpose (`--from-load`: the loading is what it shows), then 0. → {start, why} */
export function previewStartFor(sidecar) {
  if (!sidecar) return { start: 0, why: 'no sidecar' };
  if (sidecar.startRequested === 'load') return { start: 0, why: 'recorded from load on purpose' };
  const arrived = (sidecar.marks ?? []).find(m => m.label === 'arrived')?.atSec;
  return Number.isFinite(arrived) ? { start: arrived, why: 'arrived mark' } : { start: 0, why: 'no arrived mark' };
}

/** The Markdown that embeds a clip's preview in a PR, linked to the full clip. */
export const embedLine = (u, alt = basename(u.file)) => u.preview
  ? `[Full-resolution video: ${alt}](${u.url}) — reduced GIF preview below.\n\n[![Reduced preview: ${alt}](${u.preview})](${u.url})`
  : `[Full-resolution video: ${alt}](${u.url})`;

/** What a clip's sidecar can vouch for, or null. Only record.mjs writes one, and it never edits, speeds up or cuts, so a
 *  sidecar of that shape means an uncut, real-speed take. `videoSec` is the recording itself; `durationSec`, all an older
 *  sidecar has, stops before the recording closes, so it runs about a second short. */
export function clipFacts(side) {
  const seconds = side?.videoSec ?? side?.durationSec;
  if (!side?.playwright || typeof side.viewport !== 'string' || !(seconds > 0)) return null;
  return { uncut: true, realSpeed: true, seconds, viewport: side.viewport, caption: `${side.viewport} take${side.commit ? ` recorded at ${String(side.commit).slice(0, 9)}` : ''}` };
}

/** Fills what the author left unset. Anything already stated stands, an `uncut: false` above all. */
const fillFacts = (entry, facts) => { for (const [k, v] of Object.entries(facts ?? {})) if (entry[k] == null || entry[k] === '') entry[k] = v; };

/** Writes uploaded links into proof.json: clips and images into media[], everything else (logs, JSON) into files[],
 *  both matched by file name. A non-media entry left in media[] by an older upload moves to files[]. */
export function linkMedia(proof, uploaded) {
  const media = Array.isArray(proof.media) ? proof.media : [];
  const files = Array.isArray(proof.files) ? proof.files : [];
  const named = (list, file) => list.find(m => m?.file && basename(m.file) === file);
  for (const u of uploaded) {
    const file = basename(u.file), kind = kindOf(file);
    if (kind === 'file') {
      const stale = named(media, file);
      if (stale) media.splice(media.indexOf(stale), 1);
      const entry = named(files, file);
      if (entry) entry.url = u.url;
      else files.push({ file, url: u.url, caption: stale?.caption ?? '' });
      continue;
    }
    const entry = named(media, file);
    // Which start the take used (#888): "arrival" (the default) or "load" (from page creation), from its sidecar.
    const start = u.start ? { start: u.start, ...(u.previewStartSec != null ? { previewStartSec: u.previewStartSec } : {}) } : {};
    if (entry) { entry.url = u.url; if (u.preview) entry.preview = u.preview; Object.assign(entry, start); if (kind === 'video') fillFacts(entry, u.facts); }
    else {
      media.push({ file, url: u.url, ...(u.preview ? { preview: u.preview } : {}), kind, ...(kind === 'video' ? { uncut: null, realSpeed: null, seconds: null, viewport: null } : {}), ...start, caption: '' });
      if (kind === 'video') fillFacts(media.at(-1), u.facts);
    }
  }
  return { ...proof, media, ...(files.length || Array.isArray(proof.files) ? { files } : {}) };
}

/** Uploads `files` (each video with its preview when `preview(file)` makes one), then proof.json last. */
export async function uploadAll({ pr, files, proofPath = null, target, read = readFileSync, write = writeFileSync, preview = null, previewStart = null, warn = () => {} }) {
  // Check the entire batch before the first network write, including a late proof/log payload.
  for (const file of [...files, ...(proofPath ? [proofPath] : [])]) {
    if (SIDECAR.test(file)) throw new PrivateClip(`proof.clip-private: ${basename(file)} is a clip's sidecar: it holds local paths and stays unpublished.`);
    const hits = kindOf(file) === 'video' ? clipPrivacyHits(clipSidecar(file, read)) : [];
    if (hits.length) throw new PrivateClip(`proof.clip-private: ${basename(file)} showed ${hitSummary(hits)}. Record a new take; this one is never published.`);
    assertPublishable(basename(file));
    if (file === proofPath || kindOf(file) === 'file') assertPublishable(readPublication(file, read, { json: file === proofPath }));
  }
  // proof-ok fails a video without uncut and realSpeed, so say so now, not after the upload.
  if (proofPath) {
    const media = JSON.parse(read(proofPath, 'utf8')).media ?? [];
    const bad = files.filter(f => kindOf(f) === 'video' && !clipFacts(clipSidecar(f, read))).filter(f => { const m = media.find(x => x?.file && basename(x.file) === basename(f)); return m?.uncut == null || m?.realSpeed == null; });
    if (bad.length) throw new IncompleteMedia(`proof.media-incomplete: ${bad.map(f => basename(f)).join(', ')}: no record.mjs sidecar (<clip>.json) beside the clip, and proof.json does not state uncut and realSpeed. Record with .claude/skills/proof/record.mjs, or state both in the clip's media entry yourself.`);
  }
  const uploaded = [];
  for (const file of files) {
    const u = { file, ...(await target.upload(pr, file)) };
    const side = kindOf(file) === 'video' ? clipSidecar(file, read) : null;
    if (side?.start) u.start = side.start;
    if (clipFacts(side)) u.facts = clipFacts(side);
    if (preview && kindOf(file) === 'video') {
      const at = previewStart ?? previewStartFor(side).start;
      u.previewStartSec = at;
      const p = preview(file, at);
      if (p.skipped) warn(`${basename(file)}: no inline preview (${p.skipped}); the PR will link the clip only`);
      else u.preview = (await target.upload(pr, p.file)).url;
    }
    uploaded.push(u);
  }
  let proofLink = null;
  if (proofPath) {
    const proof = linkMedia(JSON.parse(read(proofPath, 'utf8')), uploaded);
    assertPublishable(proof);
    write(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    const r = await target.upload(pr, proofPath);
    proofLink = r.url;
    uploaded.push({ file: proofPath, ...r });
  }
  return { uploaded, proofLink };
}

export function blockedMessage({ reason, files, pr, proofPath }) {
  const all = [...files, ...(proofPath ? [proofPath] : [])];
  return [
    `Proof upload blocked: ${reason}`,
    'Nothing was uploaded and nothing was committed. The proof stays where it is:',
    ...all.map(f => `  ${resolve(f)}`),
    'Next: tell the user the upload is blocked and where these files are. They can drag the clips into the PR description',
    `(GitHub hosts them), or run from a machine with access: node tools/proof/upload.mjs --pr ${pr}${proofPath ? ` --proof ${proofPath}` : ''} ${files.join(' ')}`,
    'Mark the Proof section "pending upload" with each clip\'s duration, viewport and commit. Never commit media to work around this.',
  ].join('\n');
}

async function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const valued = new Set(['--pr', '--repo', '--release', '--proof', '--preview-start', '--preview-seconds']);
  for (const gone of ['--repo', '--release']) if (argv.includes(gone)) console.error(`warn: ${gone} is ignored: proof goes to the proof CDN, not GitHub releases`);
  const files = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const pr = opt('--pr'), proofPath = opt('--proof') ?? null, dryRun = argv.includes('--dry-run');
  if (!pr || !/^\d+$/.test(pr) || (!files.length && !proofPath)) {
    console.error('usage: upload.mjs --pr <n> [--proof proof.json] [--dry-run] [--json] [--no-preview] [--preview-start s] [--preview-seconds s] <file>...');
    return 2;
  }
  const local = checkLocal([...files, ...(proofPath ? [proofPath] : [])]);
  for (const w of local.warnings) console.error(`warn: ${w}`);
  if (local.problems.length) { for (const p of local.problems) console.error(`error: ${p}`); return 1; }
  try {
    const target = await pickTarget({ dryRun });
    console.error(`${dryRun ? 'dry run: would upload' : 'uploading'} ${files.length + (proofPath ? 1 : 0)} file(s) to ${target.name}`);
    const previews = !dryRun && !argv.includes('--no-preview');
    const start = opt('--preview-start') != null ? Number(opt('--preview-start')) : null, seconds = Number(opt('--preview-seconds') ?? 6);
    const out = await uploadAll({ pr: Number(pr), files, proofPath, target, write: dryRun ? () => {} : writeFileSync, previewStart: start,
      preview: previews ? (file, at) => makePreview(file, { start: at, seconds }) : null, warn: m => console.error(`warn: ${m}`) });
    if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else {
      for (const u of out.uploaded) console.log(`${u.url}  (${basename(u.file)})${u.preview ? `\n  preview ${u.preview}` : ''}`);
      const clips = out.uploaded.filter(u => kindOf(u.file) === 'video');
      if (clips.length) console.log(`\nFor the PR's Proof section (the preview plays inline and links to the full clip):\n${clips.map(u => `- ${embedLine(u)}`).join('\n')}`);
      if (out.proofLink) console.log(`\nproof.json for the PR's Proof section: ${out.proofLink}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof Blocked) { console.error(blockedMessage({ reason: e.message, files, pr, proofPath })); return 3; }
    if (e instanceof IncompleteMedia || e instanceof PrivateClip) { console.error(`error: ${e.message}`); return 1; }
    throw e;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
