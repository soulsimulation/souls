// #5068 item 13: how long the stream reader waits after reads that were refused or did not answer. A page that keeps
// reading every 250 ms while an edge refuses it, among thousands doing the same, keeps a block going or sets one off.

/** The wait, ms, before the next read after `fails` failed reads in a row: exponential backoff with full jitter, a
 *  random time within a window that doubles from `base` to `cap` (250 ms, 500 ms, ... 10 s). None after a good read. */
export const backoffMs = (fails: number, random: () => number = Math.random, base = 250, cap = 10_000): number =>
  fails <= 0 ? 0 : random() * Math.min(cap, base * 2 ** (fails - 1));
