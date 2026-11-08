// One rule for a step an action owns (a reach's lean, a stroke's step to the board), the walker's hard static layer
// (locomotion/walk.ts): the invariant reads the rasterized clearance (runtime/invariants.ts humanStaticClearance), which near a
// turned footprint can read lower than the exact distance. A step that would trip it on this tick's end is not taken. That read
// syncs nothing of its own, so it adds no scan and cannot change what a later reader sees.
import {isFloater,floaterBody} from '../bodies/body.ts';
import {humanRadius} from '../bodies/humanoid.ts';
import {clearanceAt,clearanceFromObb,nearestBlocker,type LevelGrid} from '../spatial/grid.ts';
import {G_SWIM} from '../spatial/ground.ts';
import type {Spatial} from '../spatial/service.ts';
import type {Entity} from '../world/types.ts';
import {dcos,dsin,type OBB2,type Vec2} from '../core/math.ts';
import type {Runtime} from './runtime.ts';

const STATIC_TOL=0.03; // m: the static-clearance invariant's tolerance (runtime/invariants.ts)
/** The body's collision radius, as `collision.human-static` reads it (floaters their own, humanoids their look's). */
export function bodyRadius(a:Entity):number{return isFloater(a)?floaterBody(a.body).radius:humanRadius(a);}
/** #1332: what a body step asks of the world. `held`: the step is not taken (`to` is where the body stands), `blocker` names
 *  what it would have walked into. */
export type StepGuard={to:Vec2;held:boolean;blocker?:string};
/** #1332, the one step guard: a body may step from `from` to `to` unless `to` is under the invariant's limit (clearance below the
 *  radius less 3 cm) and worse than where it stands, so a body already squeezed can always step out and none steps in. It reads
 *  what `collision.human-static` reads: the grid of the body's level at `to` (paged ground: that point's window), the body's own
 *  radius, nothing in deep water on ground level 0. A caller that already holds the grid and radius it walks on (the walker)
 *  passes them, so its reads stay its own. Reads only; syncs nothing. */
export function guardBodyStep(rt:Runtime,a:Entity,from:Vec2,to:Vec2,on?:{grid:LevelGrid;radius:number}):StepGuard{
 if(from[0]===to[0]&&from[1]===to[1])return {to,held:false};
 let g=on?.grid,radius=on?.radius??0;
 if(!g){
  const sp=rt.services.spatial as Spatial|undefined;if(!sp||!a.human)return {to,held:false};
  // the ground worlds' invariant (packages/engine-mars ground-bridge.ts) does not ask this of a body in deep water
  if((a.human.level??0)===0&&sp.ground?.field?.medium(to[0],to[1])===G_SWIM)return {to,held:false};
  g=sp.levelAt(a.human.level,to);if(!g)return {to,held:false};radius=bodyRadius(a);
 }
 const c=clearanceAt(g,to);
 if(!(c<radius-STATIC_TOL&&c<clearanceAt(g,from)-1e-9))return {to,held:false};
 return {to:from,held:true,blocker:nearestBlocker(g,to)??'geometry'};
}
/** #1332: would `collision.human-static` pass this body standing idle at `at` on `level`? (Its own radius, the grid of that level
 *  at that point, the 3 cm tolerance, deep water on ground level 0 exempt; no grid there reads as the invariant reads it: nothing
 *  to check, so callers keep their own off-grid refusal.) For every placement the engine writes outside a step. Reads only. */
export function bodyStandsClear(rt:Runtime,a:Entity,at:Vec2,level:number):boolean{
 const sp=rt.services.spatial as Spatial|undefined;if(!sp)return true;
 if(level===0&&sp.ground?.field?.medium(at[0],at[1])===G_SWIM)return true;
 const g=sp.levelAt(level,at);return !g||clearanceAt(g,at)>=bodyRadius(a)-STATIC_TOL;
}
/** May this body's action step it to `to`? False only when `to` is below the invariant's limit and worse than where it stands
 *  (guardBodyStep). A body on the rack structure or aboard a carrier is checked by those, not here. */
export function staticStepClear(rt:Runtime,a:Entity,to:Vec2):boolean{
 if(!a.human||a.human.on||a.human.carrier)return true;
 return !guardBodyStep(rt,a,[a.pose.p[0],a.pose.p[2]],to).held;
}
const SETTLE_STEP=.02,SETTLE_MAX=.18; // m
/** #1070: `solids` aren't standing yet, and this body will be at `to` when they do (a door's gap turns solid at the close's
 *  contact), on `level`, which may not be the floor it stands on yet. Undefined when it will be clear there, of them and of what already stands, so nothing changes; else the smallest shift of `to` that clears
 *  them and everything already standing, or null when there is none. */
export function settleBeside(rt:Runtime,a:Entity,to:Vec2,solids:readonly OBB2[],level:number):Vec2|null|undefined{
 const sp=rt.services.spatial as Spatial|undefined;if(!sp||!a.human||a.human.on||a.human.carrier)return undefined;
 sp.sync(rt.world);const g=sp.levelAt(level,to);if(!g)return undefined;
 const limit=(isFloater(a)?floaterBody(a.body).radius:humanRadius(a))-STATIC_TOL,clearOf=(p:Vec2)=>solids.every(o=>clearanceFromObb(g,o,p)>=limit);
 const free=(p:Vec2)=>clearOf(p)&&clearanceAt(g,p)>=limit;
 if(free(to)||(level===0&&sp.ground?.field?.medium(to[0],to[1])===G_SWIM))return undefined;
 for(let k=1;k*SETTLE_STEP<=SETTLE_MAX+1e-9;k++)for(let i=0;i<8;i++){const dx=k*SETTLE_STEP*dcos(i*Math.PI/4),dz=k*SETTLE_STEP*dsin(i*Math.PI/4),p:Vec2=[to[0]+dx,to[1]+dz];
  if(free(p))return [dx,dz];}
 return null;
}
