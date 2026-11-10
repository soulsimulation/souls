// A deliberate finite chime pull; the ambient wind-chime@1 keeps its bytes.
import layers from './vocab-w2.json' with {type:'json'};
import type {DefInput} from '../schemas.ts';
const old=structuredClone(layers.find(d=>d.name==='core-wind-chime')!) as unknown as DefInput;
if(old.make.kind!=='gen')throw Error('Wind chime must remain a kit');
const args=old.make.args as {shapes:Record<string,unknown>[]};
const pivot=[0,1.6,0],grip=[0,1.15,0];
export const HAND_CHIME:DefInput={...old,version:2,
 description:'Five brass chimes on a garden hook, silent at rest. A Soul pulls the wooden pendant once to ring a short chime; the pendant and hand return to rest. Repeat for another ring.',
 tags:[...(old.tags??[]),'hand-rung','local-fixture'],
 make:{kind:'gen',gen:'kit/2',args:{...args,shapes:args.shapes.map(s=>{
  if(s.kind==='cyl'&&s.tint==='cord'&&(s.at as number[])[1]===1.05)return{...s,at:[0,1.375,0],h:.45,role:'rope',pivot};
  if(s.kind==='box'&&s.tint==='wood')return{...s,at:grip,role:'rope',pivot};
  if(s.kind==='sphere'&&s.tint==='wood')return{...s,role:'rope',pivot};
  return s;
 })}},
 params:{...old.params,condition:{type:'enum',values:['new','worn','damaged'],default:'new',doc:'finish; construction style is unsupported by this hand-rung revision'}},
 state:{rings:{type:'int',min:0,max:1000000000,default:0}},
 components:{bell:{gripAt:[0,1.15,0],pullAngle:.4},sound:{kind:'chime',radius:10,volume:.35,when:'rings',mode:'change'}},
 actions:[{name:'ring',label:'Pull the chime pendant once',roles:'anyone',reach:'touch',params:{},when:[{field:'rings',not:1000000000}],then:[{op:'increment',field:'rings',by:1}]}],
};
