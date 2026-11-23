// X1 (0.134): copied from v2/web/src/source/changed.ts, so the old page's stream reader needs nothing from v2/web.
/** More changed nodes than this in one part are read from one snapshot rather than one query each. */
export const BULK = 64;

/**
 * Reads the nodes a part changed. Each node query reads the whole public state, so a part that changes many nodes
 * (a whole world's first part: about ten thousand in full Eden) reads them from one snapshot instead, which holds the
 * same values for the same live nodes. A changed id that is no longer live is listed as removed.
 */
export function readChanged<I, V, R>(
  ids: readonly I[],
  key: (id: I) => string,
  one: (id: I) => V,
  snapshot: () => Map<string, V>,
  rec: (v: V) => R,
): { nodes: R[]; removed: string[] } {
  const nodes: R[] = [], removed: string[] = [];
  if (ids.length > BULK) {
    const all = snapshot();
    for (const id of ids) {
      const v = all.get(key(id));
      if (v) nodes.push(rec(v)); else removed.push(key(id));
    }
    return { nodes, removed };
  }
  for (const id of ids) {
    try { nodes.push(rec(one(id))); } catch { removed.push(key(id)); }
  }
  return { nodes, removed };
}
