import type {DefInput} from '../schemas.ts';

/** One preloaded raw stock becomes one separate native item only after completed work. */
export const KINDLING_DEFS: DefInput[] = [{
 schema:'def/1',name:'core-kindling-block',version:1,form:'point',
 description:'A fixed campsite preparation block with one raw wood stock. With empty hands, prepare it using a twenty-second ordinary craft routine. Natural completion consumes the stock and leaves one real kindling bundle on the block to pick up. Stopping early leaves the wood unchanged. No axe-specific contact or ignition.',
 tags:['camping','kindling-preparation','local-fixture'],synonyms:['prepare kindling','kindling block'],
 make:{kind:'gen',gen:'kit/2',args:{round:.006,shapes:[
  {kind:'cyl',at:[0,.4,0],r:.36,h:.8,segments:10,tint:'bark'},
  {kind:'cyl',at:[0,.805,0],r:.35,h:.01,segments:10,tint:'cut'},
  {kind:'cyl',at:[0,.93,0],r:.12,h:.5,segments:8,tint:'raw',pitch:Math.PI/2,when:'@stock>0',collide:false},
 ]}} as DefInput['make'],
 palette:{bark:'#69503a',cut:'#c5a875',raw:'#a77b47'},params:{},size:{box:[.72,1.06,.72]},
 state:{routineSeconds:{type:'number',min:20,max:20,default:20},stock:{type:'number',min:0,max:1,default:1},lastBy:{type:'string',max:100,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 components:{surface:{height:.81}},slots:[{id:'out',kind:'surface',p:[0,.81,0],yaw:0,height:.81,accepts:{maxSize:[.5,.3,.5],maxMass:2},capacity:1},{id:'worker',kind:'stand',p:[0,0,1],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[{name:'prepare-kindling',label:'Prepare one kindling bundle (20 seconds; empty hands)',params:{},then:[{op:'set',field:'routineSeconds',value:20}]}],
},{
 schema:'def/1',name:'core-kindling-bundle',version:1,form:'point',
 description:'A small real bundle of split kindling prepared from one wood stock. Pick it up and place it on a fitting surface or the ground. This is prepared wood, not a simulated fuel or ignition contract.',
 tags:['camping','item','kindling','recorded-item'],
 make:{kind:'gen',gen:'kit/2',args:{round:.003,shapes:[
  ...[-.06,0,.06].flatMap((x,i)=>[.025,.07].map(y=>({kind:'box',at:[x,y,0],size:[.045,.04,.3-i*.02],tint:'wood'}))),
  {kind:'box',at:[0,.055,0],size:[.21,.11,.025],tint:'twine',collide:false},
 ]}} as DefInput['make'],palette:{wood:'#d1ac73',twine:'#79674e'},params:{},state:{},
 components:{carryable:{mass:.6,grips:1}},size:{box:[.21,.11,.3]},slots:[],
}];
