// link-lease/1 (#2264; docs/design/stair-traffic.md §2): a single-file flight is a leased resource, used in one direction
// at a time. Per link: the direction (up, down, or free when nobody holds or asks), the holders (walkers admitted to it,
// on their way to its entry or on the flight) and a queue at each end. Plain data in `rt.services.linkLeases`, so a
// runtime snapshot carries it; `leaseHashInput` puts it in the state hash. Nothing here moves a body: walk.ts asks, waits
// at a holding spot, climbs or backs down through its own cancel.
//
// Admission is a pure function of the lease and the tick: requests are served by request tick, then entity id, so the
// order in which walkers step in a tick does not change who goes first.
import { hypot } from '../core/math.ts';
import type { Runtime } from './runtime.ts';

export type LeaseDir = 'up' | 'down';
export type LeaseReq = { id: string; tick: number; spot?: number };
export type LeaseHolder = { id: string; dir: LeaseDir; since: number; at: number[] };
export type Lease = {
  dir: LeaseDir | 'free';
  holders: LeaseHolder[];
  queue: { up: LeaseReq[]; down: LeaseReq[] };
  /** Ticks of the current direction's admissions (the last LEASE_TURN_ADMITS). */
  admits: number[];
  /** A holder that made no progress for LEASE_STALL_TICKS, and the walkers that were waiting on it then. */
  timeout?: { holder: string; tick: number; waiters: string[] };
};

/** The lease turns once the current direction has admitted this many walkers since the other end's first request… */
export const LEASE_TURN_ADMITS = 3;
/** …or this many ticks have passed since it (10 s). */
export const LEASE_TURN_TICKS = 200;
/** A holder with no progress for this many ticks (60 s) backs down. */
export const LEASE_STALL_TICKS = 1200;
/** A walker asks for the lease this far (m, along its route) before the flight's entry. */
export const LEASE_REQUEST_M = 3;
/** Progress: the holder's body moved at least this far (m) since it last did. */
const PROGRESS_M = 0.1;

export const linkLeases = (rt: Runtime): Map<string, Lease> => ((rt.services.linkLeases as Map<string, Lease> | undefined) ?? (rt.services.linkLeases = new Map<string, Lease>()));

const other = (d: LeaseDir): LeaseDir => (d === 'up' ? 'down' : 'up');
const byTickThenId = (a: LeaseReq, b: LeaseReq) => a.tick - b.tick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The other end's first request is due its turn: three admissions, or 10 s, in `dir` since it asked. */
function turnDue(rt: Runtime, l: Lease, dir: LeaseDir): boolean {
  const head = l.queue[other(dir)][0];
  if (!head) return false;
  return l.admits.filter((t) => t >= head.tick).length >= LEASE_TURN_ADMITS || rt.tick - head.tick >= LEASE_TURN_TICKS;
}

/** Drop holders and requests whose walker no longer leases this link (its walk ended by a path that did not release). */
function prune(l: Lease, alive: (id: string) => boolean) {
  l.holders = l.holders.filter((h) => alive(h.id));
  l.queue.up = l.queue.up.filter((r) => alive(r.id));
  l.queue.down = l.queue.down.filter((r) => alive(r.id));
  if (l.timeout) {
    l.timeout.waiters = l.timeout.waiters.filter(alive);
    if (!l.timeout.waiters.length && !l.holders.some((h) => h.id === l.timeout!.holder)) delete l.timeout;
  }
}

function settle(rt: Runtime, link: string, l: Lease) {
  if (!l.holders.length && !l.queue.up.length && !l.queue.down.length && !l.timeout) linkLeases(rt).delete(link);
  else if (!l.holders.length && !l.queue.up.length && !l.queue.down.length) l.dir = 'free';
}

export type LeaseAnswer = { admitted: true } | { admitted: false; holder: string; request: LeaseReq };

/**
 * `id` asks for `link` in direction `dir`, standing at `at`. Idempotent: a holder stays admitted, a queued walker keeps its
 * place. Admitted when it heads its end's queue and either the flight is free or held its way with no turn due, or the
 * flight is empty and the turn is its end's. `alive(id)`: that walker still leases this link.
 */
export function leaseRequest(rt: Runtime, link: string, dir: LeaseDir, id: string, at: number[], alive: (id: string) => boolean): LeaseAnswer {
  const leases = linkLeases(rt);
  let l = leases.get(link);
  if (!l) leases.set(link, (l = { dir: 'free', holders: [], queue: { up: [], down: [] }, admits: [] }));
  prune(l, alive);
  if (l.holders.some((h) => h.id === id)) return { admitted: true };
  const q = l.queue[dir];
  let request = q.find((r) => r.id === id);
  if (!request) { q.push((request = { id, tick: rt.tick })); q.sort(byTickThenId); }
  const head = q[0], oh = l.queue[other(dir)][0], cur = l.dir === 'free' ? undefined : l.dir;
  const first = l.holders[0]?.id;
  if (l.timeout) return { admitted: false, holder: l.timeout.holder, request };
  if (head.id !== id) return { admitted: false, holder: first ?? head.id, request };
  let may: boolean;
  if (l.holders.length) may = cur === dir && !turnDue(rt, l, dir);
  else if (!oh) may = true;
  else if (cur === undefined) may = byTickThenId(head, oh) < 0;
  else if (cur === dir) may = !turnDue(rt, l, dir);
  else may = turnDue(rt, l, cur);
  if (!may) return { admitted: false, holder: first ?? oh?.id ?? head.id, request };
  q.shift();
  if (l.dir !== dir) { l.dir = dir; l.admits = []; }
  l.admits = [...l.admits, rt.tick].slice(-LEASE_TURN_ADMITS);
  l.holders.push({ id, dir, since: rt.tick, at: [...at] });
  return { admitted: true };
}

/** `id` no longer holds or waits for `link` (it left the flight, its walk ended, or its route no longer takes it). */
export function leaseRelease(rt: Runtime, link: string, id: string) {
  const l = linkLeases(rt).get(link);
  if (!l) return;
  l.holders = l.holders.filter((h) => h.id !== id);
  l.queue.up = l.queue.up.filter((r) => r.id !== id);
  l.queue.down = l.queue.down.filter((r) => r.id !== id);
  if (l.timeout) {
    l.timeout.waiters = l.timeout.waiters.filter((w) => w !== id);
    if (!l.timeout.waiters.length && !l.holders.some((h) => h.id === l.timeout!.holder)) delete l.timeout;
  }
  settle(rt, link, l);
}

/** A holder at `at`: its progress clock restarts when it has moved PROGRESS_M; true once it has stood LEASE_STALL_TICKS. */
export function leaseStalled(rt: Runtime, link: string, id: string, at: number[]): boolean {
  const h = linkLeases(rt).get(link)?.holders.find((x) => x.id === id);
  if (!h) return false;
  if (hypot(at[0] - h.at[0], at[1] - h.at[1], at[2] - h.at[2]) >= PROGRESS_M) { h.at = [...at]; h.since = rt.tick; return false; }
  return rt.tick - h.since >= LEASE_STALL_TICKS;
}

/**
 * The stalled holder backs down. Holders not yet on the flight (`onFlight` false) give up their admission and wait with
 * the queue; every walker then waiting ends `traffic.lease-timeout` once it stands off the flight's ends, and nobody else
 * is admitted until they have.
 */
export function leaseTimeout(rt: Runtime, link: string, holder: string, onFlight: (id: string) => boolean) {
  const l = linkLeases(rt).get(link);
  if (!l || l.timeout) return;
  const off = l.holders.filter((h) => h.id !== holder && !onFlight(h.id));
  l.holders = l.holders.filter((h) => !off.includes(h));
  for (const h of off) { l.queue[h.dir].push({ id: h.id, tick: rt.tick }); l.queue[h.dir].sort(byTickThenId); }
  l.timeout = { holder, tick: rt.tick, waiters: [...l.queue.up, ...l.queue.down].map((r) => r.id).sort() };
}

/** `id` holds the link (is admitted to it). */
export const leaseHolds = (rt: Runtime, link: string, id: string) => !!linkLeases(rt).get(link)?.holders.some((h) => h.id === id);

/** The holder a waiter's walk ends for, when its link timed out. */
export function leaseTimedOutFor(rt: Runtime, link: string, id: string): string | undefined {
  const t = linkLeases(rt).get(link)?.timeout;
  return t && t.waiters.includes(id) ? t.holder : undefined;
}

/** Claim a holding spot (index into the link end's spots) no other walker queued at that end has claimed and `free` passes. */
export function leaseClaimSpot(rt: Runtime, link: string, dir: LeaseDir, id: string, count: number, free: (i: number) => boolean): number | undefined {
  const l = linkLeases(rt).get(link);
  const me = l?.queue[dir].find((r) => r.id === id);
  if (!l || !me) return undefined;
  const taken = new Set(l.queue[dir].filter((r) => r.id !== id && r.spot !== undefined).map((r) => r.spot!));
  for (let i = 0; i < count; i++) if (!taken.has(i) && free(i)) { me.spot = i; return i; }
  delete me.spot;
  return undefined;
}

/** The leases as plain sorted data for the state hash. */
export function leaseHashInput(rt: Runtime): [string, Lease][] {
  const m = rt.services.linkLeases as Map<string, Lease> | undefined;
  return m ? [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) : [];
}
