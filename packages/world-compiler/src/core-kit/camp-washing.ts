import type {DefInput} from '../schemas.ts';

const box=(at:number[],size:number[],tint:string,when?:string)=>({kind:'box',at,size,tint,round:0,...(when?{when}:{})});
const station:DefInput={
 schema:'def/1',name:'core-camp-wash-station',version:1,form:'point',
 description:'A camping wash bench with one supplied clean-water charge and a ribbed board for one dirty mess-kit bowl. With empty hands, scrub for ten seconds; only finished washing cleans that same supported bowl and uses the water.',
 tags:['camp','washing','local-fixture'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  ...[-.46,.46].flatMap(x=>[-.25,.25].map(z=>box([x,.4,z],[.07,.8,.07],'wood'))),
  box([0,.815,0],[1.1,.05,.7],'wood'),
  box([.25,.85,0],[.5,.02,.5],'board'),
  ...[-.15,-.075,0,.075,.15].map(z=>box([.25,.87,z],[.46,.02,.014],'rib')),
  box([-.29,.83,0],[.38,.02,.44],'enamel'),
  ...[-.49,-.09].map(x=>box([x,.86,0],[.025,.04,.46],'enamel')),
  ...[-.23,.23].map(z=>box([-.29,.86,z],[.4,.04,.025],'enamel')),
  box([-.29,.866,0],[.37,.008,.42],'water','@water>=1'),
 ]}},
 params:{wood:{type:'color',default:'#79553b'},board:{type:'color',default:'#c3a077'},rib:{type:'color',default:'#9b7752'},enamel:{type:'color',default:'#d8e5dd'},water:{type:'color',default:'#4998ba'}},
 palette:{wood:'#79553b',board:'#c3a077',rib:'#9b7752',enamel:'#d8e5dd',water:'#4998ba'},
 state:{water:{type:'number',min:0,max:1,default:1},routineSeconds:{type:'number',min:10,max:10,default:10},text:{type:'string',max:120,default:''},lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}},
 slots:[{id:'wash',kind:'surface',p:[.25,.88,0],yaw:0,height:.88,accepts:{maxSize:[.3,.12,.3],maxMass:1},capacity:1,label:'wash board'},{id:'worker',kind:'stand',p:[.25,0,.95],yaw:Math.PI}],
 components:{surface:{height:.88}},
 size:{box:[1.1,.88,.7]},
 actions:[{name:'wash-messkit',label:'Wash the dirty bowl (10 seconds, water, empty hands)',when:[{field:'water',is:1}],then:[{op:'set',field:'routineSeconds',value:10}]}],
} as unknown as DefInput;

const bowl:DefInput={
 schema:'def/1',name:'core-camp-mess-kit',version:1,form:'point',
 description:'An empty reusable enamel camping bowl, initially muddy. Put it on a camp wash station and wash it with supplied water. The same bowl stays clean when carried or set down; this operation does not store or transport food inside it.',
 tags:['camp','item','recorded-item'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'lathe',at:[0,0,0],profile:[[0,0],[.07,0],[.13,.065],[.12,.065],[.065,.012],[0,.012]],segments:8,tint:'enamel'},
  box([0,.017,0],[.12,.008,.1],'mud','!@clean'),
  box([.05,.029,.015],[.07,.01,.06],'mud','!@clean'),
  box([-.04,.028,-.02],[.06,.008,.05],'mud','!@clean'),
 ]}},
 params:{enamel:{type:'color',default:'#e9e1c8'},mud:{type:'color',default:'#65452d'}},palette:{enamel:'#e9e1c8',mud:'#65452d'},
 state:{clean:{type:'bool',default:false},text:{type:'string',max:120,default:''}},
 components:{carryable:{mass:.25,grips:1}},size:{box:[.26,.065,.26]},
} as unknown as DefInput;

export const CAMP_WASHING:DefInput[]=[station,bowl];
