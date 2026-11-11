// #1774 A4: a dev world's own record of each Soul-facing request, so a playtest can lay the client's times beside the
// world's. One JSON line per request on /v1/edge, /v1/god and /v1/world: the route as asked (path only), the arrival in
// local wall ms, status, the world's own time and the admission wait (the same numbers as Server-Timing), the client's
// Idempotency-Key and the receipt and message ids in the answer. Never a token, an Authorization header, a body or a
// query value. Only with SIM_REQUEST_RECORD=<file> on a DEV_AUTH world (http.ts mounts it); off, nothing is mounted.
// Production's per-request record is #1750's.
import { appendFile } from 'node:fs/promises';
import type { MiddlewareHandler } from 'hono';

export const REQUEST_RECORD_SCHEMA = 'world-request/1';
const REF = /^[A-Za-z0-9._:~-]{1,100}$/;
const ref = (v: unknown) => (typeof v === 'string' && REF.test(v) ? v : undefined);

/** The world and queue ms out of a Server-Timing header (`world;dur=1.2, queue;dur=0.0`). */
export function timingOf(header: string | null): {worldMs?: number; queueMs?: number} {
  const out: {worldMs?: number; queueMs?: number} = {};
  for (const m of String(header ?? '').matchAll(/(world|queue);dur=([0-9.]+)/g)) out[m[1] === 'world' ? 'worldMs' : 'queueMs'] = Number(m[2]);
  return out;
}

/** Receipt and message ids an answer names (its receipt, its events' receipts, its inbox messages, `for`). */
export function idsOf(body: unknown): {receipts?: string[]; messages?: string[]} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const b = body as Record<string, any>, receipts = new Set<string>(), messages = new Set<string>();
  const add = (s: Set<string>, v: unknown) => { const r = ref(v); if (r && s.size < 50) s.add(r); };
  add(receipts, b.receipt?.id);
  for (const e of Array.isArray(b.events) ? b.events : []) add(receipts, e?.receipt?.id);
  for (const m of [b.inbox?.latest, b.message, ...(Array.isArray(b.messages) ? b.messages : []), ...(Array.isArray(b.backlog) ? b.backlog : [])]) add(messages, m?.id);
  add(messages, typeof b.for === 'string' ? b.for : b.for?.id);
  return {...(receipts.size ? {receipts: [...receipts]} : {}), ...(messages.size ? {messages: [...messages]} : {})};
}

/** The record's file, or null (unset, or not a DEV_AUTH world): then http.ts mounts nothing. */
export const requestRecordFile = (env: Record<string, string | undefined>, devAuth: boolean): string | null => (devAuth && env.SIM_REQUEST_RECORD ? env.SIM_REQUEST_RECORD : null);

/** Mount on '*' before the admission middleware, so its Server-Timing is on the answer when this one reads it. */
export function requestRecordMiddleware(file: string, write: (line: string) => Promise<unknown> = (line) => appendFile(file, line, {mode: 0o600})): MiddlewareHandler {
  let chain: Promise<unknown> = Promise.resolve();
  return async (c, next) => {
    const path = c.req.path;
    if (!(path.startsWith('/v1/edge/') || path.startsWith('/v1/god/') || path.startsWith('/v1/world'))) return next();
    const at = Date.now(), t0 = performance.now();
    await next();
    try {
      const res = c.res, json = (res.headers.get('content-type') ?? '').includes('application/json');
      let body: unknown = null;
      // a small JSON answer is read from a clone for its ids; a stream or a long poll still open is never read here
      if (json && Number(res.headers.get('content-length') ?? 0) <= 256 * 1024) { try { body = await res.clone().json(); } catch { body = null; } }
      const rec = {v: REQUEST_RECORD_SCHEMA, at, method: c.req.method, path, status: res.status, ms: Math.round((performance.now() - t0) * 10) / 10,
        ...timingOf(res.headers.get('server-timing')), key: ref(c.req.header('idempotency-key')), load: res.headers.get('x-sim-load') ?? undefined, ...idsOf(body)};
      const line = JSON.stringify(rec) + '\n';
      chain = chain.then(() => write(line)).catch(() => {});   // in order; a failed write never reaches the request
    } catch { /* the record never changes an answer */ }
  };
}
