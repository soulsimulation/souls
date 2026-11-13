// #1625: opt-in planting; old already-sown beds keep their exact definitions.
import type {DefInput} from '../schemas.ts';
import {WATERING_CAN} from './watering-can.ts';
const bed=structuredClone(WATERING_CAN.find(d=>d.name==='core-garden-planter'&&d.version===2)!);
const make=bed.make as unknown as {args:{shapes:Record<string,unknown>[]}};
make.args.shapes.push(
 {kind:'box',at:[-.56,.38,0],size:[.18,.035,.36],tint:'wood',when:'@stock>0',collide:false},
 ...[-.11,0,.11].flatMap(z=>[
  {kind:'box',at:[-.56,.42,z],size:[.07,.07,.07],tint:'soil',when:'@stock>0',collide:false},
  {kind:'box',at:[-.56,.49,z],size:[.12,.025,.05],tint:'leaf',roll:.3,when:'@stock>0',collide:false},
 ]),
);
export const PLANTING_BED:DefInput={...bed,version:3,
 description:'An unsown garden bed with one supplied tray of seedlings. With empty hands, plant them using ten seconds of ordinary craft/tool work. Only natural completion uses the tray and starts the sprouts. Water with a watering can; the same plants then grow and wilt on ordinary world days. Stopping early leaves the tray intact. No arbitrary seed inventory or instant harvest.',
 tags:[...bed.tags!,'seedling-planting'],components:{...bed.components,sign:{lines:['Unsown bed; one supplied seedling tray. Plant with empty hands (10 seconds).','After planting, water and tend this same growing bed.']}},size:{box:[1.3,.9,.5]},
 state:{...bed.state,text:{type:'string',max:220,default:''},planted:{type:'bool',default:false},stock:{type:'number',min:0,max:1,default:1},routineSeconds:{type:'number',min:10,max:10,default:10},lastBy:{type:'string',max:100,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 slots:[{id:'worker',kind:'stand',p:[0,0,.9],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[{name:'plant-seedlings',label:'Plant the supplied seedlings (10 seconds; empty hands)',params:{},then:[{op:'set',field:'routineSeconds',value:10}]}],
};
