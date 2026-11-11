// The platform feed (#1876): one site-level list of news that any client pulls, never pushed.
//
//   GET  <base>/v1/feed?after=<id>&limit=N   public, no credentials: {items:[{id, at, kind, title, body, url?, startsAt?,
//        place?, minClient?, replaces?}], next}, oldest first after the cursor; `next` is the cursor for the next call.
//        An item that a later item `replaces` is left out. Public cache headers; the request carries no Soul id, account
//        or token, and nothing about the reader is kept but one count per UTC day per `x-soul-client` version.
//   POST <base>/__sim/op/feed-post    operator only (direct loopback): {kind, title, body?, url?, startsAt?, place?,
//        minClient?, replaces?} → appends one item to <data>/feed.jsonl (append-only; a correction is a new item that
//        replaces the old one). op.mjs feed-post.
//   POST <base>/__sim/op/feed-stats   operator only: {days:{'YYYY-MM-DD':{<client version>|'none'|'other': reads}}}.
//        op.mjs feed-stats. Kept in <data>/feed-reads.json, the last 60 days.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FEED_KINDS = Object.freeze(['announcement', 'release', 'world', 'event']);
export const FEED_LIMITS = Object.freeze({ title: 120, body: 1000, url: 500, place: 120, minClient: 32, postBytes: 8192, pageDefault: 20, pageMax: 100, versionsPerDay: 64, daysKept: 60, flushMs: 5000 });
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const ID_RE = /^f([1-9]\d{0,9})$/;
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...headers }).end(JSON.stringify(body)); };

/** A post body checked: [null, item fields] or [message, null]. */
export function checkPost(b, has) {
  if (!b || typeof b !== 'object') return ['body: a JSON object', null];
  const str = (k, max) => (b[k] === undefined || b[k] === null ? undefined : typeof b[k] === 'string' && b[k].trim() && b[k].length <= max ? b[k].trim() : false);
  if (!FEED_KINDS.includes(b.kind)) return [`kind: one of ${FEED_KINDS.join(', ')}`, null];
  const title = str('title', FEED_LIMITS.title); if (!title) return [`title: required, at most ${FEED_LIMITS.title} characters`, null];
  const body = str('body', FEED_LIMITS.body); if (body === false) return [`body: at most ${FEED_LIMITS.body} characters`, null];
  const url = str('url', FEED_LIMITS.url);
  if (url === false || (url !== undefined && (() => { try { return new URL(url).protocol !== 'https:'; } catch { return true; } })())) return ['url: an https URL', null];
  const startsAt = str('startsAt', 40); if (startsAt === false || (startsAt !== undefined && Number.isNaN(Date.parse(startsAt)))) return ['startsAt: an ISO date and time', null];
  const place = str('place', FEED_LIMITS.place); if (place === false) return [`place: at most ${FEED_LIMITS.place} characters`, null];
  const minClient = str('minClient', FEED_LIMITS.minClient); if (minClient === false || (minClient !== undefined && !VERSION_RE.test(minClient))) return ['minClient: a client version such as 2.33.0', null];
  const replaces = str('replaces', 12); if (replaces === false || (replaces !== undefined && !has(replaces))) return ['replaces: the id of an item in the feed', null];
  return [null, { kind: b.kind, title, body: body ?? '', ...(url ? { url } : {}), ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}), ...(place ? { place } : {}), ...(minClient ? { minClient } : {}), ...(replaces ? { replaces } : {}) }];
}

/** The feed of one launcher: its file, its read counts, and the two routes (mounted by launcher.mjs). */
export function platformFeed({ dataDir, log = () => {}, now = () => new Date() }) {
  const file = join(dataDir, 'feed.jsonl'), statsFile = join(dataDir, 'feed-reads.json');
  let items = [], seen = '';
  const load = () => {   // re-read only when the file changed (another launcher process may have appended during a handover)
    let st; try { st = statSync(file); } catch { items = []; seen = ''; return items; }
    const key = `${st.size}:${st.mtimeMs}`; if (key === seen) return items;
    items = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    seen = key; return items;
  };
  let days = {}; try { days = existsSync(statsFile) ? JSON.parse(readFileSync(statsFile, 'utf8')).days ?? {} : {}; } catch { days = {}; }
  let timer = null;
  const flush = () => { timer = null; try { writeFileSync(statsFile, JSON.stringify({ days })); } catch (e) { log(`feed: read counts not saved: ${e.message}`); } };
  const countRead = (header) => {
    const day = now().toISOString().slice(0, 10), v = typeof header === 'string' && header ? (VERSION_RE.test(header) ? header : 'other') : 'none';
    const d = (days[day] ??= {}); const k = d[v] !== undefined || Object.keys(d).length < FEED_LIMITS.versionsPerDay ? v : 'other';
    d[k] = (d[k] ?? 0) + 1;
    for (const old of Object.keys(days).sort().slice(0, -FEED_LIMITS.daysKept)) delete days[old];
    if (!timer) { timer = setTimeout(flush, FEED_LIMITS.flushMs); timer.unref?.(); }
  };
  /** One page after the cursor: replaced items left out, `next` past everything scanned. */
  const page = (after, limit) => {
    const all = load(), from = after ? Number(ID_RE.exec(after)[1]) : 0, hidden = new Set(all.map((i) => i.replaces).filter(Boolean));
    const out = []; let next = after ?? null;
    for (const i of all.slice(from)) { if (out.length >= limit) break; next = i.id; if (!hidden.has(i.id)) out.push(i); }
    return { items: out, next };
  };
  return {
    page, flush,
    /** GET <base>/v1/feed: anyone; the answer depends on the query alone. */
    serve(req, res, url) {
      const after = url.searchParams.get('after') || undefined, l = url.searchParams.get('limit');
      if (after !== undefined && !ID_RE.test(after)) { send(res, 400, { ok: false, code: 'bad-cursor', message: 'after: an item id from `next`' }); return; }
      const limit = l === null || l === '' ? FEED_LIMITS.pageDefault : Number(l);
      if (!Number.isInteger(limit) || limit < 1 || limit > FEED_LIMITS.pageMax) { send(res, 400, { ok: false, code: 'bad-limit', message: `limit: 1-${FEED_LIMITS.pageMax}` }); return; }
      if (req.method === 'GET') countRead(req.headers['x-soul-client']);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', 'x-robots-tag': 'noindex' }).end(req.method === 'HEAD' ? undefined : JSON.stringify(page(after, limit)));
    },
    /** POST <base>/__sim/op/feed-post | feed-stats: direct loopback only, anything through the proxy is 403. */
    async op(req, res, verb, isDirect) {
      if (!isDirect) { send(res, 403, { ok: false, code: 'local-only', message: 'operator commands are accepted only from this machine' }); return; }
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > FEED_LIMITS.postBytes) { send(res, 413, { ok: false, code: 'too-large' }); return; } chunks.push(c); }
      if (verb === 'feed-stats') { send(res, 200, { ok: true, days }); return; }
      let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { send(res, 400, { ok: false, code: 'bad-json' }); return; }
      const all = load(), [why, fields] = checkPost(b, (id) => all.some((i) => i.id === id));
      if (why) { send(res, 400, { ok: false, code: 'bad-item', message: why }); return; }
      const item = { id: `f${all.length + 1}`, at: now().toISOString(), ...fields };
      appendFileSync(file, `${JSON.stringify(item)}\n`); load();
      log(`feed: ${item.id} ${item.kind}${item.replaces ? ` replaces ${item.replaces}` : ''} (operator)`);
      send(res, 201, { ok: true, item });
    },
  };
}
