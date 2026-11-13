// #1635: opt-in authored overgrowth; prior growing planters keep their exact definitions.
import type {DefInput} from '../schemas.ts';
import {WATERING_CAN} from './watering-can.ts';
const bed=structuredClone(WATERING_CAN.find(d=>d.name==='core-garden-planter'&&d.version===2)!);
const shapes=(bed.make as unknown as {args:{shapes:Record<string,unknown>[]}}).args.shapes;
shapes.push({kind:'box',at:[.57,.36,0],size:[.32,.05,.42],tint:'wood'},
 ...[-.27,0,.27].flatMap((x,i)=>[
  {kind:'box',at:[x,.54,0],size:[.035,.34,.035],tint:'weed',round:0,when:'@weeds>0',collide:false},
  {kind:'box',at:[x-.06,.56,.04],size:[.18,.035,.1],roll:.6,tint:'weed',round:0,when:'@weeds>0',collide:false},
  {kind:'box',at:[x+.06,.63,-.03],size:[.18,.035,.1],roll:-.6,tint:'weed',round:0,when:'@weeds>0',collide:false},
 ]));
export const WEEDING_DEFS:DefInput[]=[{...bed,version:4,
 description:'A planted raised garden bed with one authored patch of weeds. With empty hands, weed it using ten seconds of ordinary garden/tool work. Natural completion clears this patch and leaves one real weed bundle on the side ledge to collect. Stopping early preserves the weeds. Existing plants still need ordinary watering; no terrain clearing, regrowth or compost simulation.',
 palette:{...bed.palette,weed:'#829543'},tags:[...bed.tags!,'weeding'],size:{box:[1.5,.9,.5]},
 state:{...bed.state,growth:{type:'number',min:0,max:4,default:2},weeds:{type:'number',min:0,max:1,default:1},text:{type:'string',max:240,default:''},routineSeconds:{type:'number',min:10,max:10,default:10},lastBy:{type:'string',max:100,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 components:{...bed.components,surface:{height:.385},sign:{lines:['Planted bed with one patch of weeds. Weed with empty hands (10 seconds).','Collect the removed weed bundle from the side ledge; keep watering the plants.']}},
 slots:[{id:'out',kind:'surface',p:[.57,.385,0],yaw:0,height:.385,accepts:{maxSize:[.3,.2,.35],maxMass:1},capacity:1},{id:'worker',kind:'stand',p:[0,0,.85],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[{name:'weed-bed',label:'Weed this bed (10 seconds; empty hands)',params:{},then:[{op:'set',field:'routineSeconds',value:10}]}],
},{schema:'def/1',name:'core-weed-bundle',version:1,form:'point',
 description:'A real small bundle of weeds removed from a raised garden bed. Pick up and place it on a fitting surface or the ground. No composting or soil-fertility effect.',tags:['garden','item','recorded-item','weeds'],
 make:{kind:'gen',gen:'kit/2',args:{round:.002,shapes:[...[-.06,0,.06].map((x,i)=>({kind:'box',at:[x,.035,0],size:[.03,.05,.25-i*.02],tint:'stem'})),{kind:'box',at:[0,.07,0],size:[.2,.05,.12],tint:'leaf',roll:.2}]}} as DefInput['make'],
 palette:{stem:'#8a7950',leaf:'#829543'},params:{},state:{},components:{carryable:{mass:.15,grips:1}},size:{box:[.22,.11,.25]},slots:[],}];
