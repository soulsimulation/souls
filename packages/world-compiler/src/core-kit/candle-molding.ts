import type {DefInput} from '../schemas.ts';
import {HAND_FIRE} from './hand-fire.ts';
const text=(max:number)=>({type:'string',max,default:''}),count=(max:number,initial=0)=>({type:'int',min:0,max,default:initial});
export const CANDLE_FORMS=['pillar','taper'] as const;
export const CANDLE_COLORS={red:'#c9544e',blue:'#5680b9',ivory:'#eadfb9'} as const;
const colors=Object.keys(CANDLE_COLORS);
const fire=HAND_FIRE.find(def=>def.name==='core-candle-stand')!;
export const MOLDED_CANDLE:DefInput={schema:'def/1',name:'core-molded-candle',version:1,form:'point',category:'object.tool',
 description:'A real portable candle molded from one finite wax portion and one wick. Place it on a stable reachable surface, then light or put out its wick using the ordinary candle faculty. No heat simulation, fuel depletion, loaded carrier or precise grip claim.',
 tags:['candle','lighting','hand-operated','item'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'cyl',at:[0,.11,0],r:.07,h:.22,segments:12,tint:'wax',when:'form=pillar'},
  {kind:'cone',at:[0,.11,0],r:.07,h:.22,segments:12,tint:'wax',when:'form=taper'},
  {kind:'cyl',at:[0,.228,0],r:.003,h:.016,segments:4,tint:'valve'},
  {kind:'cone',at:[0,.258,0],r:.012,h:.045,segments:6,tint:'flame',role:'flame',glow:1,pivot:[0,.236,0],when:'@on'}]}},
 params:{form:{type:'enum',values:[...CANDLE_FORMS],default:'pillar'},wax:{type:'color',default:CANDLE_COLORS.ivory}},
 palette:{wax:CANDLE_COLORS.ivory,valve:'#302e29',flame:'#ffb347'},size:{box:[.16,.29,.16]},
 components:{carryable:{mass:.25,grips:1},light:{color:'#ffb860',range:2,on:true,at:[0,.26,0]}},
 state:{on:{type:'bool',default:false},form:{type:'enum',values:[...CANDLE_FORMS],default:'pillar'},waxColor:{type:'enum',values:colors,default:'ivory'},waxUnits:count(1,1),wickUnits:count(1,1),maker:text(80),sourceLabel:text(60)},
 actions:structuredClone(fire.actions)} as unknown as DefInput;
const action=(name:string,label:string,params={})=>({name,label,params,then:[{op:'set',field:'workSeconds',value:4}]});
export const CANDLE_MOLD_BENCH:DefInput={schema:'def/1',name:'core-candle-mold-bench',version:1,form:'point',category:'object.tool',
 description:'A supplied fixed candle mold bench. Choose pillar or taper and red, blue or ivory; four seconds of native handwork consumes one matching finite wax portion and one wick, producing one real portable usable candle in its output slot. Clear the output before making another. No heating or liquid-wax physics.',
 tags:['workbench','surface','candle','molding','hand-operated','local-fixture'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'box',at:[0,.88,0],size:[1.4,.08,.7],tint:'wood'},
  ...[-.6,.6].flatMap(x=>[-.25,.25].map(z=>({kind:'box',at:[x,.42,z],size:[.08,.84,.08],tint:'wood'}))),
  {kind:'cyl',at:[-.35,.94,.04],r:.12,h:.04,segments:10,tint:'metal'},
  ...colors.flatMap((color,i)=>[1,2].map(n=>({kind:'box',at:[-.5+i*.25,.95+(n-1)*.06,-.22],size:[.16,.06,.12],tint:color,when:`@${color}>=${n}`}))),
  {kind:'box',at:[.5,.94,-.22],size:[.18,.04,.1],tint:'wick',when:'@wicks>0'}]}},
 palette:{wood:'#b88850',metal:'#7f817e',wick:'#e7d8ab',...CANDLE_COLORS},params:{},size:{box:[1.4,1.05,.7]},
 slots:[{id:'output',kind:'surface',p:[.35,.92,.08],yaw:0,height:.92,accepts:{maxSize:[.2,.35,.2],maxMass:1},capacity:1}],
 components:{surface:{height:.92}},
 state:{form:{type:'enum',values:[...CANDLE_FORMS],default:'pillar'},waxColor:{type:'enum',values:colors,default:'ivory'},red:count(2,2),blue:count(2,2),ivory:count(2,2),wicks:count(6,6),made:count(6),maker:text(80),lastOutput:text(120),workSeconds:{type:'int',min:4,max:4,default:4},lastReceipt:text(120),lastCompletedTick:{type:'int',min:-1,max:1e12,default:-1}},
 actions:[action('choose-form','Choose pillar or taper',{text:{type:'string',max:12,doc:'pillar or taper'}}),action('choose-color','Choose finite red, blue or ivory wax',{text:{type:'string',max:12,doc:'red, blue or ivory'}}),action('mold-candle','Mold one real usable candle (4 seconds)')]} as unknown as DefInput;
