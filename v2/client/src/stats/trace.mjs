// The client's own trace (Engine v2 R10, #2702): one local JSON line per command answered, intent sent and answer
// taken, in the Soul's runtime folder (`trace.jsonl`, mode 0600), like today's `soul-trace/1`. It holds names and
// counts only: no world text, no token, no host. Nothing reads it but `stats` on this machine, and nothing sends it
// anywhere: this module imports no network code.
//
//   {"t":<wall ms>,"k":"cmd","op":"look","bytes":812}            a command's answer, and the bytes it printed
//   {"t":...,"k":"send","seq":7,"ranked":2}                      an intent sent, with how many verbs it ranked
//   {"t":...,"k":"answer","seq":7,"cause":"accepted-first","achieved":true}
//
// `t` is this machine's wall clock, to line the trace up with a harness's transcript on the same machine; an answer's
// age never comes from it (`../daemon/age.mjs`).

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA = 'souls-v2-trace/1';
/** The trace is kept to about this size: past it, the file becomes `trace.old.jsonl`, and the one before goes. */
export const TRACE_MOST = 4 * 1024 * 1024;

/**
 * The first-send result's cause (#2702's closed list), from an answer's kind (1 receipt, 2 refused, 3 accepted,
 * 4 resolved, 5 unread), its reason or outcome, and how many verbs the intent ranked. A receipt does not say which
 * ranked verb the engine took, so one for a ranked list is `accepted-rank-unstated`.
 */
export function causeOf(kind, name, ranked = 1) {
  if (kind === 1 || kind === 3 || kind === 4) return ranked > 1 ? 'accepted-rank-unstated' : 'accepted-first';
  if (kind === 2) {
    if (/expir/.test(name)) return 'expired';
    if (/stale|basis|changed/.test(name)) return 'refused-stale';
    if (/restarting|load|busy|full|budget|rate/.test(name)) return 'refused-load';
  }
  return 'refused-never';
}

/** Achieved: the act ended `completed`. Until acts' ends are on the wire (I4), a receipt is the end the client sees. */
export const achievedOf = (kind, name) => kind === 1 || (kind === 4 && name === 'completed');

/** The trace in runtime folder `dir`: `write(record)` appends one line, `read()` gives every record kept. */
export function openTrace(dir, { most = TRACE_MOST } = {}) {
  const file = join(dir, 'trace.jsonl'), old = join(dir, 'trace.old.jsonl');
  return {
    file,
    write(record) {
      try {
        if (existsSync(file) && statSync(file).size > most) renameSync(file, old);
        appendFileSync(file, JSON.stringify({ t: Date.now(), ...record }) + '\n', { mode: 0o600 });
      } catch { /* a trace that cannot be written never stops an answer */ }
    },
    read: () => [old, file].flatMap((f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []))
      .filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }),
  };
}
