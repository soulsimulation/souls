import {actuatorHand,twoHanded,handActuatorFrame,handActuatorParams,type HandActuatorMotion} from '../../engine/social/hand-actuator.ts';
import {POS_Q,type Take} from '../../engine/take/types.ts';
import type {Vec3} from '../../engine/core/math.ts';
export type ObservedActuatorHands={left?:Vec3;right?:Vec3};

type Certificate = {kind:'certified';motion:HandActuatorMotion;hands:ObservedActuatorHands;lower:number;upper:number} | {kind:'fallback';reason:string};
const owners=['hands','grip','on','handHold','rps','heldItemsV1','itemTransferV1','handTransferV1','wateringV1','cupV1','letGoV1','sleepPose','prop','instrument','game','partner'] as const;
const empty=(value:unknown):boolean=>value===undefined||value===null||typeof value==='object'&&!Array.isArray(value)&&Object.keys(value as object).length===0;
const clear=(state:Record<string,unknown>,includeHands=true)=>owners.every(key=>!includeHands&&key==='hands'||empty(state[key]));
const same=(a:unknown,b:unknown):boolean=>{
  if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const x=Object.keys(a).sort(),y=Object.keys(b).sort();
  return x.length===y.length&&x.every((key,i)=>key===y[i]&&same((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]));
};
function motionValid(value:unknown,actor:string):value is HandActuatorMotion {
  if(!value||typeof value!=='object')return false;
  const m=value as HandActuatorMotion&{actor?:string};
  const {startTick:_tick,actionId:_id,abortedAt:_abort,abortWeight:_weight,...params}=m;
  if(!handActuatorParams.safeParse({...params,actor:params.actor??actor}).success)return false;
  return (m.actor===undefined||m.actor===actor)&&typeof m.target==='string'&&m.target.length>0&&typeof m.actionId==='string'&&m.actionId.length>0&&
    Number.isInteger(m.startTick)&&Array.isArray(m.at)&&m.at.length===3&&m.at.every(Number.isFinite)&&
    (m.hand===undefined||m.hand==='left'||m.hand==='right')&&m.abortedAt===undefined;
}
/** Read-only index of first actuator publications. It cannot recover an episode outside its current adjacent interval. */
export class ObservedActuatorIntervals {
  private intervals=new Map<string,Map<number,Certificate>>();
  private readonly take:Take;
  constructor(take:Take){
    this.take=take;
    if(!Number.isFinite(take.dt)||take.dt<=0||!Number.isInteger(take.startTick)||!Number.isInteger(take.ticks)||take.ticks<0)return;
    const changes=new Map<string,Take['changes']>();
    for(const c of take.changes){let list=changes.get(c[1]);if(!list)changes.set(c[1],list=[]);list.push(c);}
    for(const [actor,list] of changes){
      const record=take.entities0?.[actor],certs=new Map<number,Certificate>();this.intervals.set(actor,certs);
      // Only the first recorded actor snapshot proves absence. Final state never proves prior ownership.
      const validActor=record?.kind==='human'&&record.id===actor&&!!record.human;
      const rawInitial=validActor?record.human as unknown as Record<string,unknown>:{};
      // Prefix state contains only fixed certification fields, never whole entity/history clones.
      type Prefix={tick:number;state:Record<string,unknown>;present:boolean;removed:boolean;motions:number};
      const fields=new Set<string>([...owners,'activity','task','handActuator']);
      const initial=Object.fromEntries([...fields].filter(key=>key in rawInitial).map(key=>[key,rawInitial[key]]));
      const prefixes:Prefix[]=[{tick:-Infinity,state:initial,present:false,removed:false,motions:0}];
      const publications:{tick:number;value:unknown}[]=[];
      const candidates=new Map<number,{value:unknown;end:Prefix}>();
      const unordered=list.some(([tick],i)=>i>0&&tick<list[i-1][0]);
      for(let i=0;i<list.length;){
        const upper=list[i][0],before=prefixes[prefixes.length-1];
        const end:Prefix={...before,tick:upper,state:{...before.state}};
        let candidate:unknown,hasCandidate=false;
        do {
          const [, ,key,value]=list[i++];
          if(fields.has(key))end.state[key]=value;
          if(key==='present'){end.present=value===true;if(value===false)end.removed=true;}
          if(key==='handActuator'&&!empty(value)){
            publications.push({tick:upper,value});end.motions++;
            candidate=value;hasCandidate=true;
          }
        }while(i<list.length&&list[i][0]===upper);
        prefixes.push(end);
        if(hasCandidate)candidates.set(upper,{value:candidate,end});
      }
      const prefixAt=(tick:number)=>{
        let lo=0,hi=prefixes.length;
        while(lo+1<hi){const mid=(lo+hi)>>1;if(prefixes[mid].tick<=tick)lo=mid;else hi=mid;}
        return prefixes[lo];
      };
      for(const [upper,{value,end:upperPrefix}] of candidates){
        const fail=(reason:string)=>certs.set(upper,{kind:'fallback',reason});
        if(!validActor){fail('missing-actor-lineage');continue;}
        if(!Number.isInteger(upper)||upper<1||upper>take.ticks){fail('unobserved-interval');continue;}
        if(!motionValid(value,actor)){fail('invalid-native-episode');continue;}
        const lower=upper-1,start=value.startTick-take.startTick;
        if(start<lower||start>=upper){fail('start-outside-interval');continue;}
        if(unordered){fail('unordered-observations');continue;}
        const lowerPrefix=prefixAt(lower),prior=lowerPrefix.state,end=upperPrefix.state;
        if(upperPrefix.removed){fail('removed-actor-lineage');continue;}
        if(!lowerPrefix.present||!upperPrefix.present){fail('missing-adjacent-actor');continue;}
        if(!['idle','walk','jog','run'].includes(String(prior.activity))){fail('prior-activity-not-clear');continue;}
        if(prior.task!==undefined&&prior.task!==null){fail('prior-task-not-clear');continue;}
        if(!empty(prior.handActuator)||!clear(prior)){fail('prior-ownership-not-clear');continue;}
        let mixed=false;
        for(let i=lowerPrefix.motions;i<upperPrefix.motions;i++)if(!same(publications[i].value,value)){mixed=true;break;}
        if(!['reach','operate'].includes(String(end.activity))||!clear(end,false)||mixed||!same(end.handActuator,value)||(end.task!==undefined&&end.task!==null&&end.task!==value.actionId)){fail('mixed-interval-owner');continue;}
        if(handActuatorFrame(value,(take.startTick+upper-value.startTick)*take.dt).done){fail('completed-episode');continue;}
        const raw=end.hands as {left?:unknown;right?:unknown}|undefined;
        const wanted=twoHanded(value.stroke)?['left','right'] as const:[actuatorHand(value.opening,value.hand)];
        const hands:ObservedActuatorHands={};
        if(!raw||Object.keys(raw).some(key=>!wanted.includes(key as 'left'|'right'))||wanted.some(key=>{
          const p=raw[key as 'left'|'right'];
          if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))return true;
          hands[key as 'left'|'right']=[p[0]/POS_Q,p[1]/POS_Q,p[2]/POS_Q];return false;
        })){fail('missing-or-mixed-endpoint-hands');continue;}
        certs.set(upper,{kind:'certified',motion:value,hands,lower,upper});
      }
    }
  }
  sample(actor:string,tick:number):Certificate {
    if(!Number.isFinite(tick)||tick<0||tick>=this.take.ticks)return {kind:'fallback',reason:'outside-recording'};
    const upper=Math.floor(tick)+1,certificate=this.intervals.get(actor)?.get(upper);
    if(!certificate)return {kind:'fallback',reason:'no-current-interval-episode'};
    if(certificate.kind==='certified'&&tick<certificate.motion.startTick-this.take.startTick)return {kind:'fallback',reason:'before-native-start'};
    return certificate;
  }
}
