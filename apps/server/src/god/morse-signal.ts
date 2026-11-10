import {opSchema,type Entity,type Op,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {supportY} from './nav.ts';
const CODES:Record<string,string>={A:'.-',B:'-...',C:'-.-.',D:'-..',E:'.',F:'..-.',G:'--.',H:'....',I:'..',J:'.---',K:'-.-',L:'.-..',M:'--',N:'-.',O:'---',P:'.--.',Q:'--.-',R:'.-.',S:'...',T:'-',U:'..-',V:'...-',W:'.--',X:'-..-',Y:'-.--',Z:'--..','0':'-----','1':'.----','2':'..---','3':'...--','4':'....-','5':'.....','6':'-....','7':'--...','8':'---..','9':'----.'};
export const morseCode=(text:string)=>text.split('').map(c=>CODES[c]).join(' ');
type No={code:string;reason:string};type Soul=Pick<EdgeSoul,'soulId'|'entityId'|'name'>;
type Body={pose?:{p:number[]};human?:{activity?:string;holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type MorseHost={model:WorldModel;worldId:string;engine:{world:{tick:number;entities:Record<string,Body>};programOf(id:string):string|null};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,s:Soul):No|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};
type Work={id:string;action:string;body:string;soul:string;name:string;world:string;tick:number;text:string;code:string;stamp:string;receipt:string;program:string;spent:boolean;on:boolean;pulses:number;invalid:boolean};
export function createMorseSignal(h:MorseHost){
 const requested=new Map<string,Work>(),pending=new Map<string,Work>();
 const fail=(reason:string):No=>({code:'object.state',reason});
 const lamp=(id:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return e&&d?.name==='core-morse-signal-lamp'&&d.version===1?e:null;};
 const held=(body:string)=>Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===body);
 const stamp=(e:Entity)=>{const parent=h.model.entities.get(e.in.parent);return JSON.stringify([e.def,e.owner,e.access,e.by,e.params,e.state,e.in,h.model.worldPose(e),h.engine.world.entities[e.id]?.support,parent&&[parent.def,parent.owner,parent.access,parent.params,parent.state,h.model.worldPose(parent)]]);};
 function textOf(text:unknown){return typeof text==='string'&&/^[A-Z0-9]{1,3}$/.test(text.trim().toUpperCase())?text.trim().toUpperCase():null;}
 function check(s:Soul,id:string,text:unknown){
  const e=lamp(id);if(!e)return fail('The signal lamp is no longer there.');const denied=h.denied(id,s);if(denied)return denied;
  const b=h.engine.world.entities[s.entityId];if(!b?.human||!b.pose?.p)return fail('Your native body is unavailable.');
  if(b.human.holding||b.human.hands||b.human.handActuator||held(s.entityId))return fail('Empty your hands and put the same signal lamp on a fixed table before transmitting.');
  const normalized=textOf(text);if(!normalized)return fail('Choose one to three letters A–Z or digits0–9 in text.');
  const support=h.engine.world.entities[e.id]?.support,parent=h.model.entities.get(e.in.parent);
  if(support?.kind!=='resting-on'||support.on!==e.in.parent||!parent||h.model.resolvedDef(parent.def)?.name!=='core-table')return fail('Put the same signal lamp on a fixed table first.');
  const no=h.denied(parent.id,s);if(no)return no;
  if(Number(e.state?.charges??3)<1)return fail('This lamp has no battery charges left; no recharge or free reset is supplied.');
  if(e.state?.active===true)return fail('The signal lamp is already transmitting; stop its current native work before starting another message.');
  const p=h.model.worldPose(e),level=h.levelAt(p.x,p.z,supportY(h.model,e));
  return{e,parent,p,level,text:normalized,encoded:morseCode(normalized)};
 }
 function plan(s:EdgeSoul,id:string,action:string,params?:Record<string,unknown>){
  if(!lamp(id)||action!=='transmit')return null;const c=check(s,id,params?.text);if('code'in c)return c;
  const pp=h.model.worldPose(c.parent),gap=h.model.resolvedDef(c.parent.def)!.size.box[2]*pp.s/2+.6,front=[pp.x+Math.sin(pp.yaw)*gap,pp.z+Math.cos(pp.yaw)*gap];
  const steps:{verb:string;params:Record<string,unknown>}[]=[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:front[0],z:front[1],level:c.level}}];
  const letters=c.encoded.split(' ');
  for(let i=0;i<letters.length;i++)for(let j=0;j<letters[i].length;j++){
   steps.push({verb:'mars:pose_v1',params:{activity:'operate',seconds:letters[i][j]==='.'?.5:1.5,face:[c.p.x,c.p.z]}});
   steps.push({verb:'mars:pose_v1',params:{activity:'nod',seconds:j===letters[i].length-1&&i<letters.length-1?1.5:.5,base:'idle',release:true,clear:true,face:[c.p.x,c.p.z]}});
  }
  steps.push({verb:'stand',params:{}});
  return{summary:`Transmit ${c.text} as ${c.encoded}; one finite battery charge is spent only when actual native signaling starts.`,steps};
 }
 function begin(s:EdgeSoul,id:string,action:string,params:Record<string,unknown>){if(!lamp(id)||action!=='transmit')return;const c=check(s,id,params.text);if('code'in c)return;requested.set(s.soulId,{id,action,body:s.entityId,soul:s.soulId,name:s.name.slice(0,80),world:h.worldId,tick:h.engine.world.tick,text:c.text,code:c.encoded,stamp:stamp(c.e),receipt:'',program:'',spent:false,on:false,pulses:0,invalid:false});}
 function valid(q:Work){const e=lamp(q.id),s=h.soul(q.soul),body=h.engine.world.entities[q.body];return !!e&&!!s&&!!body?.human&&s.entity_id===q.body&&q.world===h.worldId&&stamp(e)===q.stamp&&!held(q.body)&&!h.denied(e.id,{soulId:s.id,entityId:q.body,name:s.name})&&!h.denied(e.in.parent,{soulId:s.id,entityId:q.body,name:s.name});}
 function write(q:Work,state:Record<string,unknown>){const e=lamp(q.id);if(!e||!h.commit([opSchema.parse({op:'set',id:q.id,state})],'Native signal lamp phase').accepted)return false;q.stamp=stamp(lamp(q.id)!);return true;}
 function clear(q:Work){const e=lamp(q.id);if(e&&e.state?.session===q.receipt)h.commit([opSchema.parse({op:'set',id:q.id,state:{on:false,active:false,session:'',activeText:'',pulse:0}})],'Release native signal lamp');}
 function tick(){for(const [receipt,q]of pending){
  if(!valid(q)){q.invalid=true;clear(q);pending.delete(receipt);continue;}
  if(h.engine.programOf(q.body)!==q.program){q.invalid=true;clear(q);pending.delete(receipt);continue;}
  if(h.engine.world.tick<=q.tick)continue;
  const e=lamp(q.id)!,b=h.engine.world.entities[q.body],on=b.human?.activity==='operate';
  if(on){const p=h.model.worldPose(e),at=b.pose?.p;if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>2||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,supportY(h.model,e))){q.invalid=true;clear(q);pending.delete(receipt);continue;}}
  if(on===q.on)continue;
  const state:Record<string,unknown>={on,active:true,session:q.receipt,activeText:q.text,pulse:q.pulses+(on?1:0)};
  if(on&&!q.spent){state.charges=Number(e.state?.charges??3)-1;q.spent=true;}
  if(!write(q,state)){q.invalid=true;clear(q);pending.delete(receipt);continue;}
  q.on=on;if(on)q.pulses++;
 }}
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):transmit$/.exec(r.capability);
  if(r.phase==='started'){const q=requested.get(r.soulId);requested.delete(r.soulId);if(q&&m&&q.id===m[1]&&q.tick===r.acceptedTick&&r.programId){q.receipt=r.id;q.program=r.programId;pending.set(r.id,q);}return;}
  if(!['completed','failed','replaced'].includes(r.phase))return;const q=pending.get(r.id);pending.delete(r.id);if(!q)return;
  const e=lamp(q.id),s=h.soul(q.soul),body=h.engine.world.entities[q.body];
  if(r.phase!=='completed'||q.invalid||!m||q.id!==m[1]||q.soul!==r.soulId||!valid(q)||!e||!s||!body?.pose?.p||r.programId!==q.program||!Number.isSafeInteger(r.endedTick)||r.endedTick!<=q.tick||r.endedTick!<Number(e.state?.lastCompletedTick??-1)||!q.spent||q.pulses!==q.code.replaceAll(' ','').length||e.state?.lastReceipt===r.id){clear(q);return;}
  const p=h.model.worldPose(e),at=body.pose.p;if(Math.hypot(at[0]-p.x,at[2]-p.z)>2||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,supportY(h.model,e))){clear(q);return;}
  if(!h.commit([opSchema.parse({op:'set',id:q.id,state:{on:false,active:false,session:'',activeText:'',pulse:0,message:q.text,code:q.code,transmissions:Number(e.state?.transmissions??0)+1,lastBy:q.name,lastReceipt:r.id,lastCompletedTick:r.endedTick}})],'Completed native Morse transmission').accepted){h.log('morse signal: completed history refused');clear(q);}
 }
 // Once-only recovery: an interrupted server cannot retain an engine-owned flashing session.
 for(const e of h.model.entities.values())if(lamp(e.id)&&e.state?.session)h.commit([opSchema.parse({op:'set',id:e.id,state:{on:false,active:false,session:'',activeText:'',pulse:0}})],'Recover interrupted native signal');
 return{plan,begin,onReceipt,tick,facts(id:string){const e=lamp(id);return e?{signal:`Portable signal lamp: battery charges ${e.state?.charges??3}/3; light ${e.state?.on?'ON':'off'}; ${e.state?.active?'transmitting '+e.state.activeText+' at pulse '+e.state.pulse:'idle'}. Completed transmissions ${e.state?.transmissions??0}; last message ${e.state?.message||'none'}; Morse ${e.state?.code||'none'}; transmitter ${e.state?.lastBy||'none'} (completed snapshot). Choose1–3 letters/digits in text. Native dot0.5s/dash1.5s follow native operation, gaps native nod. Fixed table, empty hands. Charge spent at first actual signaling; interruption turns off and keeps earlier completed history. No receiver, range or receipt-by-another-Soul claim.`}:null;}};
}
export type MorseSignal=ReturnType<typeof createMorseSignal>;
