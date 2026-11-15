// The security headers every answer of a world carries (#1006, #1017, #1025): never framed, and not indexed except the
// public pages http.ts names. One definition, used by the Hono app (http.ts), the answers main.ts writes itself (/mcp,
// the restart 503) and the read worker's own answers (split/read-worker.ts). Kept small so the read worker does not load
// the HTTP app to get them.
export const FRAME_ANCESTORS = "frame-ancestors 'none'";
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': FRAME_ANCESTORS,
});

/** A route's own CSP keeps its directives and gains `frame-ancestors 'none'`; with none, the shared one. */
export function withFrameAncestors(csp: string | null | undefined): string {
  if (!csp?.trim()) return FRAME_ANCESTORS;
  const kept = csp.split(';').map(s => s.trim()).filter(s => s && !/^frame-ancestors\b/i.test(s));
  return [...kept, FRAME_ANCESTORS].join('; ');
}

/** For a Node answer written outside Hono: the shared headers, set before writeHead. */
export function setSecurityHeaders(res: {setHeader(name: string, value: string): unknown}) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}
