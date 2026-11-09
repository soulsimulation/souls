import type {DefInput} from '../schemas.ts';
const box=(at:number[],size:number[],tint:string,when?:string)=>({kind:'box',at,size,tint,round:0,...(when?{when}:{})});
const state={routineSeconds:{type:'number',min:10,max:10,default:10},on:{type:'bool',default:false},fuel:{type:'number',min:0,max:1,default:1},text:{type:'string',max:120,default:''},lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}};
export const CAMP_FISH_DEFS:DefInput[]=[{
 schema:'def/1',name:'core-camp-grill',version:1,form:'point',tags:['camping','cooking','hand-operated','local-fixture'],
 description:'A fixed camp grill with one supplied charcoal charge. Light it by hand, place a raw camp fish on the cooking surface, then cook with empty hands for ten seconds. Cooking uses the charge and puts the coals out. No timed combustion simulation.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  ...[-.28,.28].flatMap(x=>[-.18,.18].map(z=>box([x,.4,z],[.05,.8,.05],'iron'))),
  box([0,.76,0],[.65,.08,.46],'iron'),box([0,.81,0],[.56,.02,.37],'coal'),
  box([0,.823,0],[.5,.008,.3],'ember','@on'),
  ...[-.2,-.1,0,.1,.2].map(x=>box([x,.85,0],[.015,.015,.4],'iron')),
  {kind:'cyl',at:[.29,.87,.24],r:.025,h:.03,segments:6,tint:'valve'},
 ]}},palette:{iron:'#363b3f',coal:'#252321',ember:'#ed782d',valve:'#c1a16b'},params:{},state,
 slots:[{id:'food',kind:'surface',p:[0,.86,0],yaw:0,height:.86,accepts:{maxSize:[.25,.14,.22],maxMass:1},capacity:1},{id:'worker',kind:'stand',p:[0,0,.95],yaw:Math.PI,accepts:{},capacity:1}],
 components:{surface:{height:.86},light:{color:'#f5a14c',range:2,on:true,at:[0,.82,0]}},size:{box:[.65,.9,.55]},
 actions:[{name:'light',label:'Light the supplied charcoal',roles:'anyone',reach:'touch',params:{},when:[{field:'on',is:false},{field:'fuel',is:1}],then:[{op:'set',field:'on',value:true}]},{name:'put-out',label:'Put out the camp grill',roles:'anyone',reach:'touch',params:{},when:[{field:'on',is:true}],then:[{op:'set',field:'on',value:false}]},{name:'cook-fish',label:'Cook the raw fish (10 seconds; lit grill; empty hands)',roles:'anyone',reach:'touch',params:{},when:[{field:'on',is:true},{field:'fuel',is:1}],then:[{op:'set',field:'routineSeconds',value:10}]}],
} as unknown as DefInput,{
 schema:'def/1',name:'core-camp-fish',version:1,form:'point',tags:['camping','item','food','edible','recorded-item'],
 description:'A small supplied fish portion. Raw, it cannot be eaten. Cook it on a lit camp grill; the same portion browns, can be picked up and eaten in two bites, leaving skin.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  box([0,.025,0],[.14,.05,.07],'raw','!@cooked'),
  box([0,.025,0],[.14,.05,.07],'cooked','@cooked&@left>0.6'),
  box([-.035,.025,0],[.07,.05,.07],'cooked','@cooked&@left>0.05&@left<=0.6'),
  box([0,.004,0],[.12,.008,.055],'skin','@cooked&@left<=0.05'),
  box([-.085,.012,0],[.03,.015,.055],'skin'),
 ]}},palette:{raw:'#d9a69b',cooked:'#bc713a',skin:'#606963'},params:{},
 state:{cooked:{type:'bool',default:false},left:{type:'number',min:0,max:1,default:0},bites:{type:'number',min:1,max:8,default:2},text:{type:'string',max:120,default:''}},
 components:{carryable:{mass:.12,grips:1}},size:{box:[.2,.055,.07]},
 actions:[{name:'eat',label:'Eat the cooked fish',when:[{field:'cooked',is:true}],then:[{op:'set',field:'left',value:0}]},{name:'bite',label:'Take a bite of the cooked fish',when:[{field:'cooked',is:true}],then:[{op:'set',field:'left',value:0}]}],
} as unknown as DefInput];
