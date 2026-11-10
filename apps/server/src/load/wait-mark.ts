// #1750 A6: the time a request spends awaiting the world's sequencer (host.enqueue resolves at the next tick) is not work
// the request does on the thread, so admission does not charge it. world.ts wraps its enqueue promises in sequencerWait;
// the admission middleware runs each admitted handler inside a mark and subtracts what accumulated there.
import {AsyncLocalStorage} from 'node:async_hooks';

const mark = new AsyncLocalStorage<{ms: number}>();
/** Run `f` with a fresh mark; returns the result and a reader of the ms awaited on the sequencer inside it so far. */
export function withSequencerMark<T>(f: () => T): {result: T; awaitedMs: () => number} {
  const s = {ms: 0};
  return {result: mark.run(s, f), awaitedMs: () => s.ms};
}
/** A promise that resolves when the sequencer has applied an event: its waiting time is noted in the current mark. */
export function sequencerWait<T>(p: Promise<T>): Promise<T> {
  const s = mark.getStore(); if (!s) return p;
  const t = performance.now();
  return p.finally(() => { s.ms += performance.now() - t; });
}
