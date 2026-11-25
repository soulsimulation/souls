#!/usr/bin/env node
// move-assets.mjs — copy the asset CDN's bucket (eden-assets, served at assets.eden.art) into soul.game's
// (soul-game-assets, served at cdn.soul.game) with identical keys, bytes and headers. The source is only read.
//
//   node tools/cdn/move-assets.mjs plan   [options]   both listings, what a copy would move; reads only
//   node tools/cdn/move-assets.mjs apply  [options]   copies what the target lacks; run again after a stop, it resumes
//   node tools/cdn/move-assets.mjs verify [options]   every key copied: count, bytes, MD5 (the ETag) and SHA-256; --deep
//                                                     reads each target object back and checks its SHA-256 and headers
//   node tools/cdn/move-assets.mjs cors [--apply] [options]   the buckets' CORS rules side by side; --apply gives the
//                                                     target the source's rules exactly
//   node tools/cdn/move-assets.mjs undo --yes [options]   deletes from the target only the objects this tool created and
//                                                     that are still the bytes it wrote; never touches the source
//
// Options:
//   --from <env file>      source keys: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (default: the main checkout's
//                          .local/project/team/secrets/eden-assets-r2.env)
//   --from-endpoint <url>  source R2 endpoint (default: R2_ENDPOINT in --from, else https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com
//                          from the environment or deploy.env)
//   --to <env file>        target keys: ASSETS_ACCESS_KEY_ID, ASSETS_SECRET_ACCESS_KEY, R2_ENDPOINT (default: the main
//                          checkout's .local/project/team/secrets/r2-soul-game.env)
//   --to-endpoint <url>    target R2 endpoint (default: R2_ENDPOINT in --to)
//   --from-bucket, --to-bucket   default eden-assets, soul-game-assets
//   --state <dir>          the journal of what apply wrote (default .local/cdn-move/ at the repo root)
//   --all-proofs           copy proofs/ too (default: only proof objects the repository links to)
//   --concurrency <n>      parallel copies (default 8)
//   --json                 print the summary as JSON
//
// What moves: every object of the source bucket except `proofs/` (PR proof media, linked from GitHub only), unless the
// repository links that proof key from assets.eden.art or cdn.soul.game. Content-Type, Cache-Control,
// Content-Encoding (assets/br/ objects are stored brotli and stay so), Content-Disposition, Content-Language and every
// x-amz-meta-* header are copied as stored. Bodies are read raw (never decoded) and checked against the source's ETag
// (MD5) or its x-amz-meta-[encoded-]sha256 before they are written; the target's answer must carry the MD5 written.
// An object the target already holds with the same size and ETag (or the bytes this tool wrote for the same source
// object) is done; one that differs and was not written here is reported and kept (`--force` replaces it).
// Keys and endpoints are read from files and never printed. Tests: move-assets.test.mjs (two local S3 stand-ins).
import { isMain } from '../lib/is-main.mjs';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployEnv } from '../world-launcher/deploy/deploy-env.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The main checkout (a worktree's .git is a file naming it); secrets live there, not in a worktree.
function mainRoot() {
  try { return resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim(), '..'); }
  catch { return ROOT; }
}
const SECRETS = () => resolve(mainRoot(), '.local/project/team/secrets');
export const COPIED_HEADERS = ['content-type', 'cache-control', 'content-encoding', 'content-disposition', 'content-language', 'expires'];
export const PROOFS = 'proofs/';
/** The CDN's CORS rule, as R2's dashboard takes it: what assets.eden.art answers today (GET and HEAD from the three app
 *  origins; ETag, Content-Length and Content-Type readable by the page, which checks length and hash). */
export const CORS_RULE = [{ AllowedOrigins: ['https://soul.game', 'https://souls.game', 'https://sim.eden.art'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'], MaxAgeSeconds: 86400 }];
export const corsXml = (rules) => `<CORSConfiguration>${rules.map((r) => `<CORSRule>${r.AllowedOrigins.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')}${r.AllowedMethods.map((m) => `<AllowedMethod>${m}</AllowedMethod>`).join('')}${r.AllowedHeaders.map((h) => `<AllowedHeader>${h}</AllowedHeader>`).join('')}${r.ExposeHeaders.map((h) => `<ExposeHeader>${h}</ExposeHeader>`).join('')}<MaxAgeSeconds>${r.MaxAgeSeconds}</MaxAgeSeconds></CORSRule>`).join('')}</CORSConfiguration>`;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const md5 = (b) => createHash('md5').update(b).digest();
const hmac = (k, v) => createHmac('sha256', k).update(v).digest();
const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const unquote = (etag) => String(etag ?? '').replace(/^W\//, '').replace(/"/g, '');

/** KEY=value lines of a private settings file. Refuses a file others can read. */
export function readEnvFile(file) {
  const info = statSync(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw Error(`${file} must be a regular file readable by its owner only (mode 600)`);
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

export function endpointOf(value, what) {
  const u = new URL(value);
  const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || loopback) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error(`${what}: an endpoint is https://<host> with no path`);
  return u.origin;
}

/** One S3 bucket over SigV4, path-style. `request` answers {status, headers, body} with the body raw (never decoded). */
export function bucket({ endpoint, name, accessKeyId, secretAccessKey, region = 'auto' }) {
  if (!accessKeyId || !secretAccessKey) throw Error(`bucket ${name}: no keys`);
  const base = new URL(endpoint);
  function sign(method, path, query, headers, body) {
    const time = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), day = time.slice(0, 8), scope = `${day}/${region}/s3/aws4_request`;
    const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: base.host, 'x-amz-date': time, 'x-amz-content-sha256': sha256(body) };
    const keys = Object.keys(h).sort();
    const q = Object.entries(query).map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
    const canonical = [method, path, q, keys.map((k) => `${k}:${h[k]}\n`).join(''), keys.join(';'), h['x-amz-content-sha256']].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', time, scope, sha256(canonical)].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
    h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${keys.join(';')}, Signature=${createHmac('sha256', key).update(toSign).digest('hex')}`;
    return { headers: h, q };
  }
  function once(method, key, { query = {}, headers = {}, body = Buffer.alloc(0) } = {}) {
    const path = `/${name}${key === undefined ? '' : '/' + key.split('/').map(enc).join('/')}`;
    const { headers: h, q } = sign(method, path, query, headers, body);
    if (body.length) h['content-length'] = String(body.length);
    return new Promise((ok, fail) => {
      const req = (base.protocol === 'https:' ? https : http).request({ method, hostname: base.hostname, port: base.port || undefined, path: path + (q ? `?${q}` : ''), headers: h, timeout: 300_000 }, (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
        res.on('error', fail);
      });
      req.on('timeout', () => req.destroy(Error(`${method} timed out`)));
      req.on('error', fail);
      req.end(body);
    });
  }
  async function request(method, key, opts) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await once(method, key, opts);
        if (r.status < 500 || attempt >= 4) return r;
      } catch (e) { if (attempt >= 4) throw e; }
      await new Promise((r) => setTimeout(r, 250 * 4 ** attempt));
    }
  }
  async function list() {
    const out = new Map();
    let token;
    do {
      const r = await request('GET', undefined, { query: { 'list-type': '2', 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) } });
      if (r.status !== 200) throw Error(`list ${name}: HTTP ${r.status}`);
      const xml = r.body.toString('utf8');
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const field = (f) => (new RegExp(`<${f}>([\\s\\S]*?)</${f}>`).exec(m[1]) ?? [])[1];
        const key = xmlText(field('Key'));
        out.set(key, { key, size: Number(field('Size')), etag: unquote(xmlText(field('ETag') ?? '')) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText((/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml) ?? [])[1] ?? '') : undefined;
    } while (token);
    return out;
  }
  return { name, request, list };
}
const xmlText = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

/** Proof keys the repository links to (from either CDN host); those proofs move with the rest. */
export function referencedProofs(root = ROOT) {
  try {
    const out = execFileSync('git', ['grep', '-ohIE', 'https://(assets\\.eden\\.art|cdn\\.soul\\.game)/proofs/[A-Za-z0-9._~%/-]+'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
    return new Set(out.split('\n').filter(Boolean).map((u) => decodeURIComponent(new URL(u).pathname.slice(1)).replace(/[.)]+$/, '')));
  } catch { return new Set(); }
}

/** The keys the repository's manifests name on the CDN: what the site and `pnpm assets:pull` load. */
export function referencedKeys(root = ROOT) {
  const keys = new Set();
  const asset = JSON.parse(readFileSync(resolve(root, 'tools/assets/manifest.json'), 'utf8'));
  for (const f of asset.files) if (f.url) keys.add(new URL(f.url).pathname.slice(1));
  const cdn = resolve(root, 'apps/web/src/cdn-manifest.json');
  if (existsSync(cdn)) for (const k of readFileSync(cdn, 'utf8').match(/"key"\s*:\s*"([^"]+)"/g) ?? []) keys.add(/"key"\s*:\s*"([^"]+)"/.exec(k)[1]);
  return keys;
}

export function selectKeys(source, { allProofs = false, proofs = new Set() } = {}) {
  const chosen = new Map(), excluded = { count: 0, bytes: 0 };
  for (const [k, o] of source) {
    if (!allProofs && k.startsWith(PROOFS) && !proofs.has(k)) { excluded.count++; excluded.bytes += o.size; continue; }
    chosen.set(k, o);
  }
  return { chosen, excluded };
}

function readJournal(file) {
  const j = new Map();
  if (!existsSync(file)) return j;
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) { const e = JSON.parse(line); j.set(e.key, e); }
  return j;
}
/** Whether the target's object is the source's: same size and ETag, or the bytes this tool wrote for that source object. */
export function same(src, dst, journal) {
  if (!dst || dst.size !== src.size) return false;
  if (dst.etag === src.etag) return true;
  const e = journal.get(src.key);
  return !!e && e.srcEtag === src.etag && e.dstEtag === dst.etag;
}

function compare(chosen, target, journal) {
  const todo = [], kept = [];
  let done = 0, doneBytes = 0;
  for (const [k, o] of chosen) {
    const t = target.get(k);
    if (same(o, t, journal)) { done++; doneBytes += o.size; } else if (t) kept.push(k); else todo.push(o);
  }
  return { todo, kept, done, doneBytes };
}

/** Body integrity against what the source says it holds. */
export function bodyCheck(src, r) {
  const body = r.body, h = r.headers;
  if (body.length !== src.size) return `length ${body.length}, listed ${src.size}`;
  if (!src.etag.includes('-') && md5(body).toString('hex') !== src.etag) return 'MD5 differs from the source ETag';
  const want = h['content-encoding'] ? h['x-amz-meta-encoded-sha256'] : h['x-amz-meta-sha256'];
  if (want && sha256(body) !== want) return 'SHA-256 differs from the source metadata';
  return null;
}

export function copyHeaders(h) {
  const out = {};
  for (const k of COPIED_HEADERS) if (h[k] !== undefined) out[k] = h[k];
  for (const [k, v] of Object.entries(h)) if (k.startsWith('x-amz-meta-')) out[k] = v;
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export async function run(command, { from, to, state, allProofs = false, proofs = referencedProofs(), references = referencedKeys(), concurrency = 8, force = false, deep = false, yes = false, applyCors = false, log = () => {} }) {
  const journalFile = resolve(state, 'copied.jsonl');
  const journal = readJournal(journalFile);
  if (command === 'cors') {
    // The bucket's CORS rule (which pages may fetch it). The source's rule when its token may read it, else CORS_RULE
    // (what assets.eden.art answers today); --apply gives the target that rule.
    const [s, t] = await Promise.all([from.request('GET', undefined, { query: { cors: '' } }), to.request('GET', undefined, { query: { cors: '' } })]);
    const src = s.status === 200 ? s.body.toString('utf8') : corsXml(CORS_RULE), dst = t.status === 200 ? t.body.toString('utf8') : '';
    const rules = (x) => [...x.matchAll(/<CORSRule>([\s\S]*?)<\/CORSRule>/g)].map((m) => m[1].replace(/\s+/g, '')).sort();
    const origins = (x) => [...new Set([...x.matchAll(/<AllowedOrigin>([^<]*)<\/AllowedOrigin>/g)].map((m) => m[1]))].sort();
    const r = { command, ruleFrom: s.status === 200 ? 'source bucket' : `built in (source CORS: HTTP ${s.status})`, sourceOrigins: origins(src), targetOrigins: origins(dst), targetStatus: t.status, same: JSON.stringify(rules(src)) === JSON.stringify(rules(dst)), applied: false, dashboardJson: s.status === 200 ? undefined : CORS_RULE };
    if (applyCors && !r.same) {
      const body = Buffer.from(src);
      const p = await to.request('PUT', undefined, { query: { cors: '' }, body, headers: { 'content-type': 'application/xml', 'content-md5': md5(body).toString('base64') } });
      if (p.status !== 200) throw Error(`target CORS PUT: HTTP ${p.status}: the target's token may not change bucket settings; paste this rule in the dashboard (R2 > soul-game-assets > Settings > CORS policy): ${JSON.stringify(CORS_RULE)}`);
      r.applied = true;
    }
    return r;
  }
  if (command === 'undo') {
    if (!yes) throw Error('undo deletes the objects apply created in the target bucket: pass --yes');
    const target = await to.list();
    let deleted = 0, keptChanged = 0;
    for (const e of journal.values()) {
      if (!e.created) continue;
      const t = target.get(e.key);
      if (!t) continue;
      if (t.etag !== e.dstEtag) { keptChanged++; continue; }
      const r = await to.request('DELETE', e.key);
      if (r.status !== 204 && r.status !== 200) throw Error(`delete ${e.key}: HTTP ${r.status}`);
      deleted++;
    }
    if (existsSync(journalFile)) renameSync(journalFile, `${journalFile}.undone-${Date.now()}`);
    return { command, deleted, keptChanged };
  }
  const [source, target] = await Promise.all([from.list(), to.list()]);
  const { chosen, excluded } = selectKeys(source, { allProofs, proofs });
  const bytes = [...chosen.values()].reduce((a, o) => a + o.size, 0);
  const missingRefs = [...references].filter((k) => !source.has(k)).sort();
  const extra = [...target.keys()].filter((k) => !source.has(k)).length;
  const summary = { command, source: { objects: source.size, bytes: [...source.values()].reduce((a, o) => a + o.size, 0) }, moves: { objects: chosen.size, bytes }, excludedProofs: excluded, referencedProofs: [...proofs].filter((k) => source.has(k)).length, references: { keys: references.size, missingFromSource: missingRefs }, targetOnly: extra };
  let cmp = compare(chosen, target, journal);
  if (command === 'plan') return { ...summary, target: { holds: cmp.done, bytes: cmp.doneBytes }, toCopy: { objects: cmp.todo.length, bytes: cmp.todo.reduce((a, o) => a + o.size, 0) }, differsKept: cmp.kept.length };
  if (command === 'apply') {
    mkdirSync(state, { recursive: true });
    const work = force ? [...cmp.todo, ...cmp.kept.map((k) => chosen.get(k))] : cmp.todo;
    let copied = 0, copiedBytes = 0;
    const failed = [];
    await pool(work, concurrency, async (o) => {
      try {
        const g = await from.request('GET', o.key);
        if (g.status !== 200) throw Error(`source GET HTTP ${g.status}`);
        const bad = bodyCheck(o, g);
        if (bad) throw Error(`source body: ${bad}`);
        const digest = md5(g.body);
        const p = await to.request('PUT', o.key, { body: g.body, headers: { ...copyHeaders(g.headers), 'content-md5': digest.toString('base64') } });
        if (p.status !== 200) throw Error(`target PUT HTTP ${p.status}`);
        const dstEtag = unquote(p.headers.etag);
        if (dstEtag !== digest.toString('hex')) throw Error('target ETag is not the MD5 written');
        appendFileSync(journalFile, JSON.stringify({ key: o.key, size: o.size, srcEtag: o.etag, dstEtag, sha256: sha256(g.body), created: !target.has(o.key) }) + '\n');
        copied++; copiedBytes += o.size;
        if (copied % 100 === 0) log(`copied ${copied} of ${work.length}`);
      } catch (e) { failed.push(`${o.key}: ${e.message}`); }
    });
    return { ...summary, copied: { objects: copied, bytes: copiedBytes }, failed, differsKept: force ? 0 : cmp.kept.length, next: failed.length ? 'run apply again: it resumes' : 'run verify' };
  }
  if (command === 'verify') {
    const missing = [], differs = [], shaBad = [];
    let shaChecked = 0;
    for (const [k, o] of chosen) {
      const t = target.get(k);
      if (!t) { missing.push(k); continue; }
      if (!same(o, t, journal)) { differs.push(k); continue; }
      const e = journal.get(k);
      // MD5 is the ETag of a single-part write: equal ETags (or the journal's ETag of what was written) mean equal bytes.
      if (e?.sha256) shaChecked++;
    }
    if (deep) {
      await pool([...chosen.values()].filter((o) => target.has(o.key) && !missing.includes(o.key)), concurrency, async (o) => {
        const [s, t] = await Promise.all([from.request('GET', o.key), to.request('GET', o.key)]);
        const hs = JSON.stringify(copyHeaders(s.headers)), ht = JSON.stringify(copyHeaders(t.headers));
        if (t.status !== 200 || sha256(s.body) !== sha256(t.body) || hs !== ht) shaBad.push(o.key);
      });
    }
    const refsMissing = [...references].filter((k) => source.has(k) && !target.has(k));
    const ok = !missing.length && !differs.length && !shaBad.length && !refsMissing.length;
    return { ...summary, ok, present: chosen.size - missing.length, missing: missing.slice(0, 50), missingCount: missing.length, differs: differs.slice(0, 50), journalSha: shaChecked, deep: deep ? { checked: chosen.size - missing.length, bad: shaBad.slice(0, 50), badCount: shaBad.length } : undefined, referencesMissingFromTarget: refsMissing.slice(0, 50) };
  }
  throw Error(`unknown command ${command}`);
}

const human = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n} B`;
export function describe(r) {
  const lines = [`move-assets ${r.command}:`];
  if (r.command === 'cors') return `${lines[0]} rule from ${r.ruleFrom}; origins ${r.sourceOrigins.join(', ')}; target (HTTP ${r.targetStatus}) origins ${r.targetOrigins.join(', ') || 'none'}; ${r.same ? 'rules match' : r.applied ? 'target set to the rule' : 'rules DIFFER (cors --apply sets it)'}${r.dashboardJson ? '\n  dashboard JSON: ' + JSON.stringify(r.dashboardJson) : ''}`;
  if (r.command === 'undo') return `${lines[0]} deleted ${r.deleted} objects it had created; kept ${r.keptChanged} changed since`;
  lines.push(`  source: ${r.source.objects} objects, ${human(r.source.bytes)}; moves ${r.moves.objects} (${human(r.moves.bytes)}); proofs left out ${r.excludedProofs.count} (${human(r.excludedProofs.bytes)}), linked proofs kept ${r.referencedProofs}`);
  lines.push(`  repository manifests name ${r.references.keys} keys; missing from the source: ${r.references.missingFromSource.length}${r.references.missingFromSource.length ? ' (' + r.references.missingFromSource.slice(0, 10).join(', ') + ')' : ''}`);
  if (r.command === 'plan') lines.push(`  target holds ${r.target.holds} of them (${human(r.target.bytes)}); to copy ${r.toCopy.objects} (${human(r.toCopy.bytes)}); differ there and kept ${r.differsKept}; target-only keys ${r.targetOnly}`);
  if (r.command === 'apply') lines.push(`  copied ${r.copied.objects} (${human(r.copied.bytes)}); failed ${r.failed.length}${r.failed.length ? ': ' + r.failed.slice(0, 5).join('; ') : ''}; differ there and kept ${r.differsKept}; next: ${r.next}`);
  if (r.command === 'verify') {
    lines.push(`  target holds ${r.present} of ${r.moves.objects}, same size and MD5; SHA-256 recorded at copy ${r.journalSha}; missing ${r.missingCount}${r.missing.length ? ' (' + r.missing.slice(0, 5).join(', ') + ')' : ''}; differ ${r.differs.length}`);
    if (r.deep) lines.push(`  deep: read back ${r.deep.checked}; SHA-256 or headers differ: ${r.deep.badCount}${r.deep.bad.length ? ' (' + r.deep.bad.slice(0, 5).join(', ') + ')' : ''}`);
    lines.push(`  manifest keys missing from the target: ${r.referencesMissingFromTarget.length}`);
    lines.push(r.ok ? '  verify passed' : '  verify FAILED');
  }
  return lines.join('\n');
}

async function main(argv) {
  const command = argv[0];
  const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  const flag = (name) => argv.includes(name);
  if (!['plan', 'apply', 'verify', 'undo', 'cors'].includes(command)) { console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 28).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 2; }
  const fromFile = opt('--from', resolve(SECRETS(), 'eden-assets-r2.env')), toFile = opt('--to', resolve(SECRETS(), 'r2-soul-game.env'));
  const fe = readEnvFile(fromFile), te = readEnvFile(toFile);
  const account = deployEnv('CF_ACCOUNT_ID');
  const fromEndpoint = opt('--from-endpoint', fe.R2_ENDPOINT ?? (/^[0-9a-f]{32}$/.test(account ?? '') ? `https://${account}.r2.cloudflarestorage.com` : undefined));
  if (!fromEndpoint) throw Error('no source endpoint: --from-endpoint, R2_ENDPOINT in the --from file, or CF_ACCOUNT_ID in deploy.env');
  const toEndpoint = opt('--to-endpoint', te.R2_ENDPOINT);
  if (!toEndpoint) throw Error('no target endpoint: --to-endpoint or R2_ENDPOINT in the --to file');
  const from = bucket({ endpoint: endpointOf(fromEndpoint, 'source'), name: opt('--from-bucket', 'eden-assets'), accessKeyId: fe.R2_ACCESS_KEY_ID, secretAccessKey: fe.R2_SECRET_ACCESS_KEY });
  const to = bucket({ endpoint: endpointOf(toEndpoint, 'target'), name: opt('--to-bucket', 'soul-game-assets'), accessKeyId: te.ASSETS_ACCESS_KEY_ID ?? te.R2_ACCESS_KEY_ID, secretAccessKey: te.ASSETS_SECRET_ACCESS_KEY ?? te.R2_SECRET_ACCESS_KEY });
  const r = await run(command, { from, to, state: resolve(opt('--state', resolve(ROOT, '.local/cdn-move'))), allProofs: flag('--all-proofs'), concurrency: Number(opt('--concurrency', 8)), force: flag('--force'), deep: flag('--deep'), yes: flag('--yes'), applyCors: flag('--apply'), log: (m) => console.error(`[move-assets] ${m}`) });
  console.log(flag('--json') ? JSON.stringify(r, null, 1) : describe(r));
  if (command === 'verify') return r.ok ? 0 : 1;
  if (command === 'apply') return r.failed.length ? 1 : 0;
  return 0;
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`move-assets: ${e.message}`); process.exit(2); });
