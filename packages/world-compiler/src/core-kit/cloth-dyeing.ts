import type {DefInput} from '../schemas.ts';
const box=(at:number[],size:number[],tint:string,when?:string)=>({kind:'box',at,size,tint,round:0,...(when?{when}:{})});
const bench:DefInput={schema:'def/1',name:'core-cloth-dye-bench',version:1,form:'point',
 description:'A fixed cloth-dye bench with one indigo charge, one rust charge and two water charges. Choose solid or banded; work ten seconds with empty hands before the same supported folded cloth changes. Remaining pigment can re-dye it.',tags:['art','cloth-dyeing','local-fixture'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  ...[-.46,.46].flatMap(x=>[-.25,.25].map(z=>box([x,.46,z],[.07,.92,.07],'wood'))),
  box([0,.94,0],[1.1,.04,.7],'wood'),box([.25,.98,0],[.5,.04,.5],'board'),
  ...[-.22,.22].map(z=>box([-.31,.975,z],[.26,.03,.15],'enamel')),
  box([-.31,.995,-.22],[.2,.01,.11],'indigo','@indigo>=1'),box([-.31,.995,.22],[.2,.01,.11],'rust','@rust>=1'),
  box([-.31,.97,0],[.24,.02,.18],'enamel'),
  ...[-.44,-.18].map(x=>box([x,.99,0],[.02,.04,.2],'enamel')),
  ...[-.1,.1].map(z=>box([-.31,.99,z],[.28,.04,.02],'enamel')),
  box([-.31,.982,0],[.23,.012,.17],'water','@water>=1'),box([-.31,.994,0],[.23,.012,.17],'water','@water>=2'),
 ]}},params:{wood:{type:'color',default:'#79553b'},board:{type:'color',default:'#c3a077'},enamel:{type:'color',default:'#e9e1c8'},indigo:{type:'color',default:'#3450a0'},rust:{type:'color',default:'#b44e32'},water:{type:'color',default:'#4998ba'}},
 palette:{wood:'#79553b',board:'#c3a077',enamel:'#e9e1c8',indigo:'#3450a0',rust:'#b44e32',water:'#4998ba'},
 state:{indigo:{type:'int',min:0,max:1,default:1},rust:{type:'int',min:0,max:1,default:1},water:{type:'int',min:0,max:2,default:2},routineSeconds:{type:'int',min:10,max:10,default:10},text:{type:'string',max:160,default:''},lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'int',min:-1,max:1e12,default:-1}},
 slots:[{id:'cloth',kind:'surface',p:[.25,1,0],yaw:0,height:1,accepts:{maxSize:[.4,.08,.3],maxMass:1},capacity:1,label:'cloth board'},{id:'worker',kind:'stand',p:[.25,0,.8],yaw:Math.PI}],components:{surface:{height:1}},size:{box:[1.1,1.02,.7]},
 actions:['indigo','rust'].flatMap(color=>['solid','banded'].map(pattern=>({name:`dye-${color}-${pattern}`,label:`Dye cloth ${color} ${pattern} (10 seconds, water, empty hands)`,when:[{field:color,is:1}],then:[{op:'set',field:'routineSeconds',value:10}]}))),
} as unknown as DefInput;
const cloth:DefInput={schema:'def/1',name:'core-dyeable-cloth',version:1,form:'point',
 description:'A folded portable cloth that begins undyed. A supplied dye bench can change the same cloth to indigo or rust, solid or banded. The current treatment and maker remain on it when carried or set down; no wearable or cloth simulation.',tags:['art','item','recorded-item'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  ...['natural','indigo','rust'].flatMap((tint,i)=>[box([0,.014,0],[.36,.028,.26],tint,`@dye=${i}`),box([0,.032,-.1],[.36,.008,.06],tint,`@dye=${i}`)]),
  ...[-.14,-.07,0,.07,.14].map(x=>box([x,.03,.02],[.022,.004,.21],'natural','@banded')),
 ]}},params:{natural:{type:'color',default:'#e9dfc5'},indigo:{type:'color',default:'#3450a0'},rust:{type:'color',default:'#b44e32'}},palette:{natural:'#e9dfc5',indigo:'#3450a0',rust:'#b44e32'},
 state:{dye:{type:'int',min:0,max:2,default:0},banded:{type:'bool',default:false},text:{type:'string',max:160,default:''}},components:{carryable:{mass:.2,grips:1}},size:{box:[.36,.05,.26]},
} as unknown as DefInput;
export const CLOTH_DYEING:DefInput[]=[bench,cloth];
