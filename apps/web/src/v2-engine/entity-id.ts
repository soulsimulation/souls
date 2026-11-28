// Shared native-node to page-entity identity; no catalogue or renderer dependencies.
/** The old page's entity id for a v2 node (`[eh]_` and 4 to 12 of [a-z0-9]): the node's own id when it is one already
 *  (an imported thing), else one made from it. */
export function entityId(node: string): string {
  if (/^[eh]_[a-z0-9]{4,12}$/.test(node)) return node;
  let h = 2166136261;
  for (let i = 0; i < node.length; i++) h = Math.imul(h ^ node.charCodeAt(i), 16777619);
  let h2 = h ^ 0x9e3779b9;
  for (let i = node.length - 1; i >= 0; i--) h2 = Math.imul(h2 ^ node.charCodeAt(i), 16777619);
  return `e_v${((h >>> 0).toString(36) + (h2 >>> 0).toString(36)).slice(0, 11)}`;
}
