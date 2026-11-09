import type {DefInput} from '../schemas.ts';

/** A finite authored preparation recipe; no oven, ingredient or heat simulation. */
export const BREAD_BOARD: DefInput = {
 schema:'def/1',name:'core-bread-board',version:1,form:'point',
 description:'A fixed preparation board with three pre-measured dough portions. With empty hands, complete ten seconds of ordinary cooking to make one real portable bread roll on the dark output rack. Pick up the roll and eat it using its normal food actions. Early stopping leaves stock unchanged. No oven or heat simulation.',
 tags:['kitchen','table','bread-preparation','local-fixture'],synonyms:['bread board','prepare bread','bread roll preparation'],
 make:{kind:'gen',gen:'kit/2',args:{round:.004,shapes:[
  {kind:'box',at:[0,.965,0],size:[1.2,.03,.6],tint:'wood'},
  ...[-.5,.5].flatMap(x=>[-.2,.2].map(z=>({kind:'box',at:[x,.475,z],size:[.06,.95,.06],tint:'wood'}))),
  {kind:'box',at:[.3,.99,0],size:[.35,.02,.4],tint:'rack'},
  ...[1,2,3].map((n)=>({kind:'sphere',at:[-.45+(n-1)*.13,1.02,0],r:.045,scale:[1,.65,1],segments:8,tint:'dough',when:`@stock>=${n}`,collide:false})),
 ]}} as DefInput['make'],palette:{wood:'#b68d60',rack:'#37332e',dough:'#eee0bf'},params:{},size:{box:[1.2,1.05,.6]},
 state:{routineSeconds:{type:'number',min:10,max:10,default:10},stock:{type:'number',min:0,max:3,default:3},lastBy:{type:'string',max:100,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 components:{surface:{height:.98}},slots:[{id:'out',kind:'surface',p:[.3,1,0],yaw:0,height:1,accepts:{maxSize:[.3,.25,.3],maxMass:1},capacity:1},{id:'worker',kind:'stand',p:[0,0,1.1],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[{name:'prepare-bread',label:'Prepare a portable bread roll (10 seconds; empty hands)',params:{},then:[{op:'set',field:'routineSeconds',value:10}]}],
};
