// A creator's recent commands, refused or not (today's `eden-god trace`, kept for 0.131): the creator's daemon keeps
// the last TRACE_MOST in a ring, on disk beside its state so a restart keeps them, and `souls-god trace [n]` lists
// them newest first. It is for spotting an agent stuck in a loop: the same verb refused the same way, again and again.
// Nothing here is sent anywhere, and no words, ids or tokens are kept: the time, the verb, the result and the refusal.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TRACE_MOST = 200;
const DETAIL_MOST = 200;

/** The verb a daemon request names, as the creator typed it: `place`, `weather`, `check sky`, `batch` (several ops). */
export function verbOf(req) {
  const inner = req.world?.verb ?? (Array.isArray(req.ops) ? (req.ops.length === 1 ? req.ops[0]?.op : 'batch') : undefined);
  if (req.op === 'check') return inner ? `check ${inner}` : 'check';
  if (req.op === 'edit') return inner ?? 'edit';
  return String(req.op ?? 'unknown');
}

/** One row of the trace: when (machine clock, ISO), the verb, whether it was done, and a refusal's code, op and detail. */
export function rowOf(req, out, at = new Date()) {
  const row = { at: at.toISOString(), verb: verbOf(req), ok: out?.ok !== false };
  if (out?.ok === false) {
    row.code = String(out.code ?? 'refused');
    if (out.op !== undefined) row.op = out.op;
    if (out.detail !== undefined) row.detail = String(out.detail).slice(0, DETAIL_MOST);
  }
  if (out?.sequence !== undefined) row.sequence = out.sequence;
  if (out?.local) row.local = true;
  return row;
}

/** The ring at `dir/creator-trace.json`: `add(row)` keeps it and writes it down; `last(n)` is newest first. */
export function openCreatorTrace(dir, most = TRACE_MOST) {
  const path = join(dir, 'creator-trace.json');
  let rows = [];
  try { if (existsSync(path)) rows = JSON.parse(readFileSync(path, 'utf8')).rows ?? []; } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  rows = rows.slice(-most);
  return {
    add(row) {
      rows.push(row);
      if (rows.length > most) rows.splice(0, rows.length - most);
      try {
        writeFileSync(`${path}.tmp`, JSON.stringify({ rows }) + '\n', { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      } catch { /* the ring still holds it in memory */ }
    },
    last(n = 20) {
      return rows.slice(-Math.max(1, Math.min(most, n))).reverse();
    },
    get size() { return rows.length; },
  };
}
