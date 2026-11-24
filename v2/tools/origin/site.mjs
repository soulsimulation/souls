// The site's own pages on the new system (Engine v2 O23, #3324), served by the viewers' origin (origin.mjs) beside the
// stream files, so they keep answering once today's launcher is gone. The front door (ops/proxy/soul-game.caddy) sends
// these paths here:
//
//   GET /changelog, /changelog/   the page's changelog.html (v2/web builds it from CHANGELOG.md); with an Accept that
//                                 prefers Markdown, changelog.md, as today's launcher negotiates it
//   GET /changelog.md             the page's changelog.md
//   GET /v1/feed?after=&limit=    the platform feed in today's shape (tools/world-launcher/feed.mjs): {items:[{id, at,
//                                 kind, title, body, url?, ...}], next}, oldest first after the cursor, an item that a
//                                 later one `replaces` left out. Read from <data>/news.jsonl, where O18's release writes
//                                 one `{kind:"release", version, commit, date, link}` line per release (release.sh news);
//                                 a line already in today's item shape is served as it is.
//   GET /ops                      the read-only owner overview (ops.mjs)
//   GET /w/<slug>/<client file>    R17's installed client files and v1/config (serve.mjs); the front door selects v2 slugs
//
// Files are read when asked (no-cache: a release's new page shows at once); the feed re-reads news.jsonl when it
// changed. Nothing here writes. Only an authenticated ops data request calls the configured directory. `web` defaults to the install's
// /usr/local/lib/souls/web, `data` to /var/lib/souls and `client` to /usr/local/lib/souls/client
// (SOULS_WEB, SOULS_DATA, SOULS_CLIENT).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { opsOverview } from './ops.mjs';

// install.sh puts the served-client adapter beside this file; the checkout keeps it with the client.
const { answer } = await import(existsSync(new URL('./serve.mjs', import.meta.url)) ? './serve.mjs' : '../../client/served/serve.mjs');
const CLIENT_PATH = /^\/w\/[a-z0-9][a-z0-9-]*\/(eden\.mjs|skill\.md|creator\.md|instructions\.md|safety\.md|llms\.txt|replica\.js|replica_bg\.wasm|v1\/config)$/;

export const SITE_PATHS = Object.freeze(['/changelog', '/changelog/', '/changelog.md', '/v1/feed', '/ops', '/v1/auth/config']);
export const FEED_LIMITS = Object.freeze({ pageDefault: 20, pageMax: 100 });
const ID_RE = /^f([1-9]\d{0,9})$/;
const num = (i) => Number(ID_RE.exec(i.id)[1]);
const json = (res, status, body, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...headers }).end(JSON.stringify(body));

// C1 (#3673): a person's browser asking for a path nobody serves gets today's plain "No page here" (apps/web main.tsx
// NoPage, page-route.ts) with a link home, as a 404; programs (an Accept without text/html) and API paths keep JSON or
// empty answers.
const API_PATH = /^\/(?:v1|v2|s)(?:\/|$)|^\/(?:preview\/)?w\/[^/]+\/(?:v1|v2)(?:\/|$)/;
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Whether `req` is a browser asking for a page (GET or HEAD, Accept naming text/html) at a path that is not an API's. */
export function wantsPage(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let path; try { path = new URL(req.url, 'http://origin').pathname; } catch { return false; }
  return !API_PATH.test(path) && /\btext\/html\b/i.test(String(req.headers.accept ?? ''));
}

/** The "No page here" page for `path`, linking home. */
export function noPageHtml(path) {
  let shown; try { shown = decodeURIComponent(path); } catch { shown = path; }
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>No page here</title><style>body{margin:0;background:#10141a;color:#e8e6e1;font:16px/1.5 system-ui,sans-serif}'
    + 'main{max-width:640px;margin:12vh auto;padding:0 20px}h1{font-size:24px;margin:0 0 12px}code{overflow-wrap:anywhere}a{color:#8fb8f0;display:inline-block;padding:10px 0;min-height:24px}</style></head>'
    + `<body><main><h1>No page here</h1><p>There is nothing at <code>${escapeHtml(shown.slice(0, 200))}</code>.</p><p><a href="/">See the worlds</a></p></main></body></html>`;
}

/** Answers `req` with the 404 "No page here" page. */
export function noPage(req, res) {
  const body = Buffer.from(noPageHtml(new URL(req.url, 'http://origin').pathname));
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' })
    .end(req.method === 'HEAD' ? undefined : body);
}

/** One line of news.jsonl as a feed item, or null. O18's release entry becomes today's `release` item. */
export function feedItem(line, n) {
  let i;
  try { i = JSON.parse(line); } catch { return null; }
  if (!i || typeof i !== 'object') return null;
  if (typeof i.title === 'string') return ID_RE.test(i.id) ? i : { ...i, id: `f${n}` };   // today's shape (#1993: a line without a stored id keeps its line number)
  if (i.kind !== 'release' || typeof i.version !== 'string' || typeof i.link !== 'string') return null;
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(i.date) ? `${i.date}T00:00:00Z` : i.date);
  if (Number.isNaN(at)) return null;
  return { id: `f${n}`, at: new Date(at).toISOString(), kind: 'release', title: `Soul ${i.version}`, body: `Release ${i.version} is live.`, url: i.link };
}

/** The feed over `<data>/news.jsonl`: `page(after, limit)` and the route. */
export function newsFeed(dataDir) {
  const file = join(dataDir, 'news.jsonl');
  let items = [], seen = '';
  const load = () => {
    let st; try { st = statSync(file); } catch { items = []; seen = ''; return items; }
    const key = `${st.size}:${st.mtimeMs}:${st.ino}`; if (key === seen) return items;
    items = readFileSync(file, 'utf8').split('\n').flatMap((l, n) => (l ? [feedItem(l, n + 1)] : [])).filter(Boolean);
    seen = key; return items;
  };
  const page = (after, limit) => {
    const all = load(), from = after ? num({ id: after }) : 0, hidden = new Set(all.map((i) => i.replaces).filter(Boolean));
    const out = []; let next = after ?? null;
    for (const i of all.filter((x) => num(x) > from)) { if (out.length >= limit) break; next = i.id; if (!hidden.has(i.id)) out.push(i); }
    return { items: out, next };
  };
  const serve = (req, res, url) => {
    const after = url.searchParams.get('after') || undefined, l = url.searchParams.get('limit');
    if (after !== undefined && !ID_RE.test(after)) return json(res, 400, { ok: false, code: 'bad-cursor', message: 'after: an item id from `next`' });
    const limit = l === null || l === '' ? FEED_LIMITS.pageDefault : Number(l);
    if (!Number.isInteger(limit) || limit < 1 || limit > FEED_LIMITS.pageMax) return json(res, 400, { ok: false, code: 'bad-limit', message: `limit: 1-${FEED_LIMITS.pageMax}` });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', 'x-robots-tag': 'noindex' }).end(req.method === 'HEAD' ? undefined : JSON.stringify(page(after, limit)));
  };
  return { page, serve };
}

/** Whether an Accept header prefers Markdown to HTML (today's launcher's `wantsMarkdown`, copied). */
export function wantsMarkdown(accept = '') {
  let md = null, html = null;
  for (const [i, part] of String(accept).toLowerCase().split(',').entries()) {
    const [type, ...params] = part.split(';').map((s) => s.trim());
    const qp = params.find((p) => p.startsWith('q=')), q = qp ? Number(qp.slice(2)) : 1;
    if (!Number.isFinite(q)) continue;
    if (type === 'text/markdown' && md === null) md = { q, i };
    if ((type === 'text/html' || type === 'application/xhtml+xml') && (html === null || q > html.q)) html = { q, i };
  }
  if (!md || md.q <= 0) return false;
  return !html || md.q > html.q || (md.q === html.q && md.i < html.i);
}

/** Only the existing provider's public page fields, never an environment spread or account/token data. */
export function publicAuth(env = process.env) {
  const key = env.CLERK_PUBLISHABLE_KEY, issuer = env.CLERK_ISSUER_URL;
  if (env.AUTH_PROVIDER !== 'clerk' || !/^pk_(live|test)_[A-Za-z0-9+/=_-]+$/.test(key ?? '')) return null;
  let host;
  try {
    const u = new URL(issuer);
    host = Buffer.from(key.split('_').slice(2).join('_'), 'base64').toString();
    if (u.protocol !== 'https:' || u.origin !== issuer || u.username || u.password || host !== `${u.hostname}$`) return null;
  } catch { return null; }
  const cfg = { authProvider: 'clerk', clerkPublishableKey: key, clerkIssuer: issuer };
  const domain = env.CLERK_SATELLITE_DOMAIN, signInUrl = env.CLERK_SIGN_IN_URL;
  if (domain || signInUrl) {
    try {
      const u = new URL(signInUrl);
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain ?? '') || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.origin === `https://${domain}`) return null;
      cfg.clerkSatellite = { domain, signInUrl: u.href };
    } catch { return null; }
  }
  return cfg;
}

/** The site's routes: `handle(req, res)` answers and returns true for a site path, false for anything else. */
export function siteRoutes({ web = process.env.SOULS_WEB || '/usr/local/lib/souls/web', data = process.env.SOULS_DATA || '/var/lib/souls', client = process.env.SOULS_CLIENT || '/usr/local/lib/souls/client', auth = process.env } = {}) {
  const feed = newsFeed(data), ops = opsOverview({ data, env: auth, publicAuth: () => publicAuth(auth) });
  const file = (req, res, name, type) => {
    let body; try { body = readFileSync(join(web, name)); } catch { json(res, 404, { ok: false, code: 'not-found' }); return; }
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache', vary: 'Accept' }).end(req.method === 'HEAD' ? undefined : body);
  };
  const handle = (req, res) => {
    const url = new URL(req.url, 'http://origin'), path = url.pathname;
    const isClient = CLIENT_PATH.test(path);
    if (!SITE_PATHS.includes(path) && !isClient) return false;
    if (path === '/ops') { ops(req, res, url); return true; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { ok: false, code: 'read-only' }, { allow: 'GET, HEAD' }); return true; }
    if (path === '/v1/auth/config') {
      const cfg = publicAuth(auth);
      // Test provider keys are confined to the same HTTP loopback setup as test sign-in.
      const host = String(req.headers.host ?? '').split(':')[0];
      const local = host === 'localhost' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host) || String(req.headers.host ?? '').startsWith('[::1]');
      if (!cfg || (cfg.clerkPublishableKey.startsWith('pk_test_') && !local)) json(res, 503, { code: 'auth-unconfigured', message: 'Sign-in is not configured. Ask the operator to configure the public provider.' });
      else res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' }).end(req.method === 'HEAD' ? undefined : JSON.stringify(cfg));
      return true;
    }
    if (isClient) {
      const a = answer(client, path);
      if (!a) json(res, 404, { ok: false, code: 'not-found' });
      // R16: the replica's files carry their content hash as an ETag (serve.mjs), for an open page's renewal check.
      else res.writeHead(a.status, { 'content-type': a.type, 'content-length': a.body.length, 'cache-control': 'no-cache', ...(a.etag ? { etag: a.etag } : {}) }).end(req.method === 'HEAD' ? undefined : a.body);
      return true;
    }
    if (path === '/v1/feed') feed.serve(req, res, url);
    else if (path === '/changelog.md' || wantsMarkdown(req.headers.accept)) file(req, res, 'changelog.md', 'text/markdown; charset=utf-8');
    else file(req, res, 'changelog.html', 'text/html; charset=utf-8');
    return true;
  };
  return { handle, feed };
}
