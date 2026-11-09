// Exact correspondence-only admission: the generic state effect must not precede a distant approach.
import type {StoredDef,WorldModel} from '@souls/world-compiler';
export function correspondenceAdmission(def:Pick<StoredDef,'name'|'version'>,action:string,distance:number,holding:boolean,reach:number,targetHeld=false,sameFloor=false):{code:string;reason:string}|null{
 if(def.name!=='core-sealed-correspondence'||def.version!==1||!['write','seal','open-seal'].includes(action))return null;
 if(distance>reach)return{code:'object.out-of-reach',reason:'Walk up to the correspondence before composing or changing its seal.'};
 if(targetHeld)return{code:'object.state',reason:'Set the correspondence down before composing or changing its seal.'};
 if(!sameFloor)return{code:'object.out-of-reach',reason:'Stand on the same floor as the correspondence before operating it.'};
 if(holding)return{code:'object.state',reason:'Set down what you are holding before composing or changing the seal.'};
 return null;
}

/** Current local message/integrity facts; no generic reader change or scan. */
export function correspondenceFacts(model:WorldModel,id:string):Record<string,unknown>|null{const e=model.entities.get(id),d=e&&model.resolvedDef(e.def);if(!e||d?.name!=='core-sealed-correspondence'||d.version!==1)return null;return{correspondence:`Integrity: ${e.state?.stage??'blank'}. Message: ${e.state?.text||'(blank)'}. Write once, seal once, open once; opened wax cannot be resealed. Set down and walk within arm reach before operating. Not confidential or cryptographically authenticated.`};}

/** Compare native standing floors, with the target already resolved through existing supportY. */
export function correspondenceSameFloor(body:readonly number[]|undefined,target:readonly number[]|undefined,levelAt:((x:number,z:number,y:number)=>number)|undefined):boolean{if(!body||!target||!levelAt)return false;return levelAt(body[0],body[2],body[1])===levelAt(target[0],target[2],target[1]);}
