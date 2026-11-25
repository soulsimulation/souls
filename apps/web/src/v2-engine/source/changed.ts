// X1 (0.134): copied from v2/web/src/source/changed.ts, so the old page's stream reader needs nothing from v2/web.
/** More changed nodes than this in one part are read from one snapshot rather than one query each, where the replica
 * cannot answer several nodes in one query (an older one). */
export const BULK = 64;

/**
 * Reads the nodes a part changed. `many` (the replica's query 7, #4684) reads them all in one call, at a cost that follows
 * the part, not the world; it returns null where the replica cannot answer it. Without it, a part that changes many
 * nodes (a whole world's first part: about ten thousand in full Eden) reads them from one snapshot, which holds the same
 * values for the same live nodes, and a smaller one queries each. A changed id that is no longer live is listed as removed.
 */
export function readChanged<I, V, R>(
  ids: readonly I[],
  key: (id: I) => string,
  one: (id: I) => V,
  snapshot: () => Map<string, V>,
  rec: (v: V) => R,
  many?: (ids: readonly I[]) => Map<string, V> | null,
): { nodes: R[]; removed: string[] } {
  const nodes: R[] = [], removed: string[] = [];
  const read = (all: Map<string, V>) => {
    for (const id of ids) {
      const v = all.get(key(id));
      if (v) nodes.push(rec(v)); else removed.push(key(id));
    }
    return { nodes, removed };
  };
  const some = ids.length ? many?.(ids) : null;
  if (some) return read(some);
  if (ids.length > BULK) return read(snapshot());
  for (const id of ids) {
    try { nodes.push(rec(one(id))); } catch { removed.push(key(id)); }
  }
  return { nodes, removed };
}
