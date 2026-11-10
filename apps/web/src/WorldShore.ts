// Web and loaded-rig consumers share exactly one recorded-contact decoder.
export {shoreDepiction,type ShoreDepiction} from '../../../mars/viewer/app/engine-view/recorded-shore.ts';
// Selected render metadata only. Core capture hashing/binding lives in WorldSceneHistory.
import {hashOf} from '../../../packages/engine-contract/src/hash.ts';
import {nativeShoreSceneV1Schema,decodeShoreAppearanceSourceV1,type NativeShoreSceneV1} from '../../../packages/engine-contract/src/shore-scene.ts';
import {inspectNativeShoreTerrain} from '../../../mars/viewer/app/engine-view/content/environment/native-shore-terrain.ts';
import type {ShoreDesign} from '../../../mars/viewer/app/engine-view/shore-preview.ts';
import {inspectConnectedNativeShore} from '../../../mars/viewer/app/engine-view/content/environment/connected-native-shore.ts';
import type {SpatialScene} from '../../../mars/viewer/engine/spatial/types.ts';
/** The connected commons spatial scene (Core f870 shore placed west of the unmodified commons); WorldCommons binds the same hash. */
const CONNECTED_COMMONS_SCENE='fb9116a3d8f05b27d4f5358625859176a33f7543d8087bb7b27b209ef6f5a7ba',CONNECTED_BOUNDS=[-62,-30,30,30] as const;
/** The producer's expansion rule (engine-mars connected-shore.ts): each dry ground is a flat level-0 axis-aligned
 * rectangle appended after the base surfaces, wholly east of the shore gate, and the bounds are their union. */
const dryGround=(s:SpatialScene['surfaces'][number])=>s.level===0&&s.y===0&&s.obb.yaw===0&&s.obb.half[0]>0&&s.obb.half[1]>0&&s.obb.c[0]-s.obb.half[0]>=-29.5;
function connectedCommonsScene(scene:SpatialScene|null,campus:string):boolean{
 if(!scene)return false;
 const base=(surfaces:SpatialScene['surfaces'])=>hashOf({bounds:[...CONNECTED_BOUNDS],levels:scene.levels,surfaces,obstacles:scene.obstacles,links:scene.links})===CONNECTED_COMMONS_SCENE;
 if(campus==='eden-commons-shore/1')return scene.bounds.every((v,i)=>v===CONNECTED_BOUNDS[i])&&base(scene.surfaces);
 if(campus!=='eden-commons-shore-expanded/1')return false;
 for(let k=scene.surfaces.length;k>=0;k--){
  const extra=scene.surfaces.slice(k);if(!extra.every(dryGround))break;
  const union=extra.reduce((b,s)=>[Math.min(b[0],s.obb.c[0]-s.obb.half[0]),Math.min(b[1],s.obb.c[1]-s.obb.half[1]),Math.max(b[2],s.obb.c[0]+s.obb.half[0]),Math.max(b[3],s.obb.c[1]+s.obb.half[1])],[...CONNECTED_BOUNDS] as number[]);
  if(scene.bounds.every((v,i)=>v===union[i])&&base(scene.surfaces.slice(0,k)))return true;
 }
 return false;
}
export type WorldShore={metadata:NativeShoreSceneV1;appearance?:ShoreDesign;profile?:'connected-commons-shore/1'};
/** The first qualified visual profile. Unsupported metadata is refused, never
 * silently replaced by a flat clearance grid. Absent shore preserves legacy. */
export function parseWorldShore(raw:unknown,scene:SpatialScene|null):WorldShore|undefined {
 if(raw===undefined)return;
 const metadata=nativeShoreSceneV1Schema.parse(raw),t=metadata.terrain;
 // The connected profile is certified by content, not by a list of capture hashes: the exact f870 terrain/water
 // (the renderer's own certificate) over the qualified connected commons scene, optionally widened by the dry
 // east/north expansion grounds. rulesVersion and staticHash are server bookkeeping (verified with the capture
 // hash by WorldSceneHistory); a new rules suffix never changes what is drawn, so it never stops the client (#1518).
 if(metadata.terrain.id==='commons-shore-terrain/1'){
  try{inspectConnectedNativeShore(metadata.terrain,metadata.water);}catch{throw Error('Unsupported connected commons shoreline capture');}
  if(!connectedCommonsScene(scene,metadata.physicalBase.campus))throw Error('Unsupported connected commons shoreline capture');
  const appearance=metadata.boat?decodeShoreAppearanceSourceV1(metadata.boat.appearance) as unknown as ShoreDesign:undefined;
  return {metadata,profile:'connected-commons-shore/1',...(appearance?{appearance}:{})};
 }
 inspectNativeShoreTerrain(t);
 const bounds=[t.originXZ[0],t.originXZ[1],t.originXZ[0]+(t.columns-1)*t.spacingMetres,t.originXZ[1]+(t.rows-1)*t.spacingMetres];
 if(!scene||scene.bounds.some((v,i)=>v!==bounds[i])||scene.obstacles.length||scene.links.length||scene.surfaces.length!==1||scene.surfaces[0].y!==0||
  metadata.water.id!=='eden-shore-water'||metadata.water.datumY!==0||metadata.water.wetBoundsXZ.some((v,i)=>v!==[-16,-12,0,12][i]))throw Error('Unsupported captured shoreline rendering profile');
 const appearance=metadata.boat?decodeShoreAppearanceSourceV1(metadata.boat.appearance) as unknown as ShoreDesign:undefined;
 return {metadata,...(appearance?{appearance}:{})};
}
