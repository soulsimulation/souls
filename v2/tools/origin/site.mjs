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
//
// Files are read when asked (no-cache: a release's new page shows at once); the feed re-reads news.jsonl when it
// changed. Nothing here writes, and nothing here makes a request of its own. `web` defaults to the install's
// /usr/local/lib/souls/web and `data` to /var/lib/souls (SOULS_WEB, SOULS_DATA).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { serveOps } from './ops.mjs';

export const SITE_PATHS = Object.freeze(['/changelog', '/changelog/', '/changelog.md', '/v1/feed', '/ops']);
export const FEED_LIMITS = Object.freeze({ pageDefault: 20, pageMax: 100 });
const ID_RE = /^f([1-9]\d{0,9})$/;
const num = (i) => Number(ID_RE.exec(i.id)[1]);
const json = (res, status, body, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...headers }).end(JSON.stringify(body));

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

/** The site's routes: `handle(req, res)` answers and returns true for a site path, false for anything else. */
export function siteRoutes({ web = process.env.SOULS_WEB || '/usr/local/lib/souls/web', data = process.env.SOULS_DATA || '/var/lib/souls' } = {}) {
  const feed = newsFeed(data);
  const file = (req, res, name, type) => {
    let body; try { body = readFileSync(join(web, name)); } catch { json(res, 404, { ok: false, code: 'not-found' }); return; }
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache', vary: 'Accept' }).end(req.method === 'HEAD' ? undefined : body);
  };
  const handle = (req, res) => {
    const url = new URL(req.url, 'http://origin'), path = url.pathname;
    if (!SITE_PATHS.includes(path)) return false;
    if (path === '/ops') { serveOps(req, res, url); return true; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { ok: false, code: 'read-only' }, { allow: 'GET, HEAD' }); return true; }
    if (path === '/v1/feed') feed.serve(req, res, url);
    else if (path === '/changelog.md' || wantsMarkdown(req.headers.accept)) file(req, res, 'changelog.md', 'text/markdown; charset=utf-8');
    else file(req, res, 'changelog.html', 'text/html; charset=utf-8');
    return true;
  };
  return { handle, feed };
}
