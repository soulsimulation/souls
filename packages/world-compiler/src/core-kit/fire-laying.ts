import type {DefInput} from '../schemas.ts';
/** A finite set of authored supplies; completed native work admits the existing fire through an ordinary God batch. */
export const FIRE_LAYING_SITE:DefInput={
 schema:'def/1',name:'core-fire-laying-site',version:1,form:'point',layer:'decor',
 description:'A marked, fixed campsite with one supplied set of stones and logs. With empty hands, spend ten seconds of ordinary garden/tool work laying the campfire. Natural completion consumes these materials and admits one real existing hand-operated campfire on the ground slot; inspect the site to find it, then light or put it out normally. Interruption preserves the supplies. If ordinary placement refuses the fire, the supplies remain unchanged. No freeform construction or fuel simulation.',
 tags:['camping','fire-preparation','local-fixture'],synonyms:['lay campfire','prepare campfire'],
 make:{kind:'gen',gen:'kit/2',args:{round:.004,shapes:[
  {kind:'box',at:[-2.7,.28,0],size:[.06,.56,.06],tint:'marker'},
  {kind:'box',at:[-2.7,.55,0],size:[.38,.15,.05],tint:'marker'},
  ...[-.5,-.2,.1,.4].map((x,i)=>({kind:'box',at:[x,.11,-.15+(i%2)*.3],size:[.22,.22,.22],tint:'stone',when:'@stock>0',collide:false})),
  ...[-.22,0,.22].map((x,i)=>({kind:'cyl',at:[x,.32,.05],r:.09,h:.8,segments:6,pitch:Math.PI/2,yaw:i*.15,tint:'wood',when:'@stock>0',collide:false})),
 ]}} as DefInput['make'],
 palette:{marker:'#9b7951',stone:'#817b70',wood:'#806045'},params:{},size:{box:[5.8,.7,1]},
 state:{stock:{type:'number',min:0,max:1,default:1},prepared:{type:'bool',default:false},routineSeconds:{type:'number',min:10,max:10,default:10},text:{type:'string',max:240,default:''},lastBy:{type:'string',max:100,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 components:{surface:{height:0},sign:{lines:['Supplied stones and logs: lay a campfire with empty hands (10 seconds).','Only natural completion creates a real fire. Inspect it to light or put it out.']}},
 slots:[{id:'out',kind:'surface',p:[0,0,0],yaw:0,height:0,accepts:{maxSize:[6,2,6],tags:['fire']},capacity:1},{id:'worker',kind:'stand',p:[0,0,1.25],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[{name:'lay-campfire',label:'Lay the supplied campfire (10 seconds; empty hands)',params:{},then:[{op:'set',field:'routineSeconds',value:10}]}],
};
