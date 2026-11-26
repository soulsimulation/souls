// Time to Live: a v2 world's stream reader starts with the page's first loading phase (early-entry.ts), not once React,
// LiveWorld, the world's /v1/scene and the bridge's chunk are in. Eden on a 4x phone asked for its stream's pointer 8 s
// in and was Live at 15 s; nothing it drew waited on the CPU, only on the stream's baseline and parts. The worker now
// fetches and plays them while the rest of the page loads, and what it posts meanwhile is kept: useV2Souls takes the
// worker (claimEarlyReader) and its listeners get those messages first, in order, then the worker's own.
// The world's /v1/scene, which the bridge needs before it starts, leaves at the same time (takeEarlyScene).
// Small on purpose: phase one loads it.
import { makeReader } from './reader.ts';
import { streamReadUrl } from './stream-cdn.ts';
import { apiPath } from '../world-path.ts';

type PageConfig = { v2Stream?: unknown; v2Replica?: unknown; v2StreamOrigin?: unknown; v2Views?: unknown };
const pageConfig = (): PageConfig | undefined => typeof window === 'undefined' ? undefined : (window as unknown as { __simConfig?: PageConfig }).__simConfig;

const STREAM = /^\/s\/[A-Za-z0-9._/-]+\/$/;
/** The v2 stream this world's page reads, when its inline config names one; else null (the old socket). */
export function v2Stream(): string | null {
  const v = pageConfig()?.v2Stream;
  return typeof v === 'string' && STREAM.test(v) && !v.split('/').some((s) => s === '.' || s === '..') ? v : null;
}

/** The replica the reader's worker loads: the one the launcher names by version (`v2Replica`, cutover.mjs: its files are
 *  immutable), else the world's plain path. */
export function replicaUrl(named: unknown): string {
  return new URL(typeof named === 'string' && /^\/(?!\/)[A-Za-z0-9._/-]+\/replica\.js$/.test(named) && !named.includes('..') ? named : apiPath('/replica.js'), location.href).href;
}

/** Not taken by then (the page never mounted its stream hook): the worker is stopped. */
export const UNCLAIMED_MS = 30_000;
/** At most this long of one task replaying what the worker posted before it was taken. */
const SLICE_MS = 8;

type Got = { data: unknown } | { error: string };
type WorkerLike = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener'>;

/** A reader worker started before its bridge: to the bridge and its watchers it is the Worker (their `message`
 *  listeners, `onmessage`, `onerror`, `postMessage`, `terminate`). Until the bridge asks it for the same stream, what the
 *  worker posts is held; then it is delivered in order, a slice a task, and what comes after it passes straight on. */
export class EarlyReader extends EventTarget {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly stream: string;
  readonly replica: string;
  private readonly worker: WorkerLike;
  private held: Got[] = [];
  private started = false;
  private replaying = false;
  private stopped = false;
  constructor(worker: WorkerLike, stream: string, replica: string) {
    super();
    this.worker = worker; this.stream = stream; this.replica = replica;
    worker.addEventListener('message', (e) => this.got({ data: (e as MessageEvent).data }));
    worker.addEventListener('error', (e) => this.got({ error: (e as ErrorEvent).message || 'the v2 reader stopped' }));
    worker.postMessage({ stream });
  }
  /** Held: messages the worker posted that nobody has had yet. */
  get pending(): number { return this.held.length; }
  postMessage(m: unknown): void {
    // the bridge's start: the stream this worker already reads, so it is not asked twice
    if (!this.started && (m as { stream?: unknown } | null)?.stream === this.stream) { this.started = true; this.replay(); return; }
    this.worker.postMessage(m);
  }
  terminate(): void { this.stopped = true; this.held = []; this.worker.terminate(); }
  private got(x: Got) {
    if (this.stopped) return;
    if (this.started && !this.replaying) this.deliver(x); else this.held.push(x);
  }
  private replay() {
    this.replaying = true;
    const step = () => {
      const until = performance.now() + SLICE_MS;
      while (this.held.length && !this.stopped) { this.deliver(this.held.shift()!); if (performance.now() >= until) break; }
      if (this.held.length && !this.stopped) { setTimeout(step, 0); return; }
      this.replaying = false;
    };
    setTimeout(step, 0);
  }
  private deliver(x: Got) {
    try {
      if ('error' in x) { const e = errorEvent(x.error); this.dispatchEvent(e); this.onerror?.(e); return; }
      const e = new MessageEvent('message', { data: x.data }); this.dispatchEvent(e); this.onmessage?.(e);
    } catch (error) { report(error); }   // as a worker's listener's would be: reported, and the next message still delivered
  }
}

const report = (error: unknown) => { if (typeof reportError === 'function') reportError(error); else setTimeout(() => { throw error; }); };
const errorEvent = (message: string): ErrorEvent => typeof ErrorEvent === 'function' ? new ErrorEvent('error', { message }) : Object.assign(new Event('error'), { message }) as ErrorEvent;

let early: EarlyReader | null = null, scene: Promise<unknown> | null = null, unclaimed: ReturnType<typeof setTimeout> | undefined;

/** Starts this page's stream reader and its /v1/scene request, when its inline config names a v2 stream (once). */
export function startEarlyReader(make: (replica: string) => WorkerLike = makeReader): EarlyReader | null {
  if (early || typeof window === 'undefined' || typeof Worker === 'undefined') return early;
  const stream = v2Stream(); if (!stream) return null;
  const config = pageConfig();
  if (config?.v2Views !== false && typeof fetch === 'function') scene = fetch(apiPath('/v1/scene')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const replica = replicaUrl(config?.v2Replica);
  const reader = early = new EarlyReader(make(replica), new URL(streamReadUrl(stream, config, location.search), location.href).href, replica);
  unclaimed = setTimeout(() => { if (early === reader) { early = null; reader.terminate(); } }, UNCLAIMED_MS);
  return reader;
}

/** The early reader when it reads exactly `stream` with `replica`, at most once per page; any other is stopped. */
export function claimEarlyReader(stream: string, replica: string): EarlyReader | null {
  const reader = early; early = null; clearTimeout(unclaimed);
  if (!reader) return null;
  if (reader.stream !== new URL(stream, location.href).href || reader.replica !== replica) { reader.terminate(); return null; }
  return reader;
}

/** The early /v1/scene answer (its JSON, or null), at most once per page; null when there was none. */
export function takeEarlyScene(): Promise<unknown> | null { const s = scene; scene = null; return s; }
