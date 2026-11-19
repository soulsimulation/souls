// Visitor counts for the front door (Engine v2 O19, #2830), carried over from apps/web/src/visitor-counts.ts: the same
// GoatCounter site (`simeden`), the same rules, the page's own count request (no third-party script). Cookieless and
// nothing personal: a world page counts as /w/<slug> (never a query string, hash, Soul id, code or token), the world list
// as /, a referrer as its origin only, the screen as its width. Off on local and private hosts, under automation
// (navigator.webdriver), on ?shot looks and where localStorage skipgc=t. A content policy with a fetch directive must
// allow the counter's origin. Not carried over: the arrival and pairing events (today's world page only).

declare const __SIM_GOATCOUNTER__: string | undefined;
const DEFAULT_CODE = 'simeden';

/** The count URL a setting names: a GoatCounter code, a full http(s) count URL, or null for off ('', 'off', '0'). */
export function countEndpoint(setting: string | undefined): string | null {
  const v = (setting ?? DEFAULT_CODE).trim();
  if (!v || v === 'off' || v === '0') return null;
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(v)) return `https://${v}.goatcounter.com/count`;
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin + u.pathname : null; } catch { return null; }
}

/** A host nobody outside reaches: never counted (localhost, the .localhost/.test/.local/.internal suffixes, tailnet names, loopback, private,
 *  link-local and tailnet addresses). */
export function localHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h === '0.0.0.0' || /\.(localhost|test|local|internal|lan|home\.arpa|ts\.net)$/.test(h)) return true;
  if (h.includes(':')) return h === '::1' || /^(f[cd]|fe[89ab])/.test(h) || h.startsWith('::ffff:') && localHost(h.slice(7));
  return /^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
}

/** The counted path of a page: /w/<slug> for a world page (nothing after the slug), / for the world list, else null. */
export function countedPath(pathname: string): string | null {
  if (pathname === '/') return '/';
  const m = pathname.match(/^\/w\/([a-z][a-z0-9-]{0,31})(?:\/|$)/);
  return m ? '/w/' + m[1] : null;
}

/** A referrer as counted: another site's origin only; one of ours as its counted path; anything else nothing. */
export function countedReferrer(referrer: string, origin: string): string {
  try {
    const u = new URL(referrer);
    if (u.origin === origin) { const p = countedPath(u.pathname); return p ? origin + p : ''; }
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
  } catch { return ''; }
}

/** One count request: GoatCounter's parameters (p path, t title, r referrer, s screen width). */
export function countUrl(endpoint: string, f: { path: string; title?: string; referrer?: string; width?: number }): string {
  const q = new URLSearchParams({ p: f.path });
  if (f.title) q.set('t', f.title);
  if (f.referrer) q.set('r', f.referrer);
  if (f.width && f.width > 0) q.set('s', String(Math.round(f.width)));
  q.set('rnd', Math.random().toString(36).slice(2, 8));
  return endpoint + '?' + q;
}

function send(url: string) {
  try { if (navigator.sendBeacon?.(url)) return; } catch { /* fall back to an image */ }
  try { const img = new Image(); img.referrerPolicy = 'no-referrer'; img.src = url; } catch { /* never breaks the page */ }
}

/** Count this page view once (later calls do nothing). */
let counted = false;
export function countPage() {
  if (counted) return;
  counted = true;
  try {
    if (typeof location === 'undefined' || typeof navigator === 'undefined' || navigator.webdriver) return;
    if (localHost(location.hostname) || new URLSearchParams(location.search).has('shot')) return;
    try { if (localStorage.getItem('skipgc') === 't') return; } catch { /* storage blocked: still counted */ }
    const at = countEndpoint(typeof __SIM_GOATCOUNTER__ === 'string' ? __SIM_GOATCOUNTER__ : undefined);
    const path = countedPath(location.pathname);
    if (!at || !path) return;
    let width = 0;
    try { width = screen.width; } catch { /* no screen */ }
    const referrer = countedReferrer(document.referrer, location.origin);
    send(countUrl(at, { path, title: path.startsWith('/w/') ? path.slice(3) : 'worlds', referrer, width }));
  } catch { /* never breaks the page */ }
}
