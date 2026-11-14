// #1937: a Soul client older than the world's minimum is told so, once, with the command that fixes it. The refusal is
// frozen (docs/architecture/api.md, "Soul client upgrade"): every released client prints an error's `message`, so the
// command is in it. Only a Soul's own calls under /v1/edge and /v1/agent are refused; the routes a client upgrades through
// (/v1/config, /eden.mjs, /skill.md, /instructions.md) never are, and nobody is refused while the world's minimum is above
// the client it serves, since then no client could upgrade far enough.
import type {Context, Hono, MiddlewareHandler} from 'hono';
import {CLIENT_HEADER} from './client-version.ts';

export const UPGRADE_REQUIRED = 'client.upgrade-required';
export const UPGRADE_RUN = 'node eden.mjs upgrade';
export const UPGRADE_MESSAGE = `This Soul client is too old for this world. Run: ${UPGRADE_RUN}`;
/** A request with no `x-soul-client` came from a client older than the header (2.32.0 was the first to send it). */
export const UNNAMED_CLIENT = '2.32.0';
const BARE = /^\d+\.\d+\.\d+$/, GUARDED = /^\/v1\/(edge|agent)(\/|$)/;

const parts = (v: string) => v.split('.').map(Number);
/** a < b, both bare versions. */
export function olderThan(a: string, b: string): boolean {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

export type ClientMinimumDeps = {
  /** The world's minimum and the client version it serves, from its manifest; none means nothing is refused. */
  served: () => {minVersion: string; version: string} | undefined;
  isSoul: (c: Context) => boolean;
  warn?: (line: string) => void;
};

export type Refusal = {ok: false; code: typeof UPGRADE_REQUIRED; message: string; min: string; have: string; run: string};
type Served = {minVersion: string; version: string} | undefined;
/** The refusal a request gets, or null. `unservable` hears a minimum above the served client, when it would have refused. */
export function refusalFor(path: string, header: string | undefined, m: Served, isSoul: () => boolean, unservable?: (m: NonNullable<Served>) => void): Refusal | null {
  if (!GUARDED.test(path)) return null;
  const have = header || UNNAMED_CLIENT;
  if (!m || !BARE.test(have) || !BARE.test(m.minVersion) || !olderThan(have, m.minVersion) || !isSoul()) return null;
  if (!BARE.test(m.version) || olderThan(m.version, m.minVersion)) { unservable?.(m); return null; }
  return {ok: false, code: UPGRADE_REQUIRED, message: UPGRADE_MESSAGE, min: m.minVersion, have, run: UPGRADE_RUN};
}

export function clientMinimum(d: ClientMinimumDeps): MiddlewareHandler {
  let warned = '';
  const unservable = (m: NonNullable<Served>) => {
    const state = `${m.minVersion}>${m.version}`;
    if (warned !== state) { warned = state; (d.warn ?? console.warn)(`[clients] the minimum client ${m.minVersion} is above the served ${m.version}: nobody is refused until it is served`); }
  };
  return async (c, next) => {
    const r = refusalFor(c.req.path, c.req.header(CLIENT_HEADER), d.served(), () => d.isSoul(c), unservable);
    return r ? c.json(r, 426) : next();
  };
}

/** One line in http.ts, before the routes it guards. */
export function mountClientMinimum(app: Hono, d: ClientMinimumDeps): void { app.use('*', clientMinimum(d)); }
