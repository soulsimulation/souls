// History-only materialization into the existing integer take schema. Native time remains in the
// worker message; display changes wait for the first tick not before it (0 <= delay <50 ms).
import type { HistoryNode } from './history-worker.ts';
export type HistoryTransition = { at: number; nodes: HistoryNode[]; removed: string[]; courses?: import('./course-samples.ts').CoursePlaces };
export function readTimeline(value: unknown, node: (v: Map<number, unknown>) => HistoryNode, id: (v: never) => string,
  from: number, to: number): { nodes: HistoryNode[]; transitions: HistoryTransition[] } {
  if (!(value instanceof Map) || Number(value.get(1)) !== from || Number(value.get(6)) !== to) throw new Error('history timeline window missing or malformed');
  const nodes = (v: unknown): HistoryNode[] => {
    if (!Array.isArray(v) || v.some((r) => !(r instanceof Map))) throw new Error('history timeline nodes malformed');
    return v.map(node);
  };
  let previous = from;
  const rows = value.get(3);
  if (!Array.isArray(rows)) throw new Error('history timeline transitions missing');
  const transitions = rows.map((r): HistoryTransition => {
    if (!(r instanceof Map)) throw new Error('history timeline transition malformed');
    const at = Number(r.get(1)); if (!Number.isSafeInteger(at)) throw new Error('history timeline time malformed');
    if (at <= from || at < previous || at > to || !Array.isArray(r.get(3))) throw new Error('history timeline transition order/window malformed');
    previous = at;
    return { at, nodes: nodes(r.get(2)), removed: r.get(3).map(id) };
  });
  return { nodes: nodes(value.get(2)), transitions };
}

