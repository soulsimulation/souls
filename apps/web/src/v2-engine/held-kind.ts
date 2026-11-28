/** Lightweight bridge into the current world's existing canonical resolver; no definitions or second catalog. */
import type {StoredDef} from '@souls/world-compiler';
import type {HeldEntry} from '../../../../mars/viewer/app/engine-view/held-entry.ts';
type HeldKind = {def:StoredDef;grip:[number,number,number];points:Record<string,{role:string;at:[number,number,number]}>;state:Record<string,boolean|number|string>};
type Resolver = (entry:HeldEntry)=>HeldKind|null;
let current:Resolver|null=null;
/** A stale world's cleanup cannot clear the replacement world's resolver. */
export function setHeldKindResolver(resolve:Resolver|null):()=>void {
  current=resolve;
  return ()=>{if(current===resolve)current=null;};
}
export const heldKindOf=(entry:HeldEntry):HeldKind|null=>current?.(entry)??null;

/** Preserve the existing old-page entity identity for imported and native nodes. */
export function entityId(node: string): string {
  if (/^[eh]_[a-z0-9]{4,12}$/.test(node)) return node;
  let h = 2166136261;
  for (let i = 0; i < node.length; i++) h = Math.imul(h ^ node.charCodeAt(i), 16777619);
  let h2 = h ^ 0x9e3779b9;
  for (let i = node.length - 1; i >= 0; i--) h2 = Math.imul(h2 ^ node.charCodeAt(i), 16777619);
  return `e_v${((h >>> 0).toString(36) + (h2 >>> 0).toString(36)).slice(0, 11)}`;
}
