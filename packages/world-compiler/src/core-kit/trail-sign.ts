import type {DefInput} from '../schemas.ts';
/** A finite set of authored supplies; completed native work admits the existing board through an ordinary God batch. */
export const TRAIL_SIGN_SITE:DefInput={
 schema:'def/1',name:'core-trail-sign-site',version:1,form:'point',layer:'decor',
 description:'A fixed trail worksite with one supplied set of timber. With empty hands, spend ten seconds of ordinary native tool work assembling a notice board. Natural completion atomically consumes the timber and admits one real existing writable notice board on the ground output. Inspect it, write your own route guidance and read it back. Interruption or ordinary placement refusal preserves the timber. One finite sign, no transport or repeating production cycle.',
 tags:['camping','trail-sign','local-fixture'],synonyms:['assemble sign','build trail sign'],
 make:{kind:'gen',gen:'kit/2',args:{round:.004,shapes:[
  {kind:'box',at:[-2.7,.28,0],size:[.06,.56,.06],tint:'marker'},
  {kind:'box',at:[-2.7,.55,0],size:[.38,.15,.05],tint:'marker'},
  ...[-.36,-.12,.12,.36].map((x,i)=>({kind:'box',at:[x,.1+i*.025,0],size:[.18,.12,1],round:0,tint:'wood',when:'@stock>0',collide:false})),
 ]}} as DefInput['make'],
 palette:{marker:'#9b7951',wood:'#806045'},params:{},size:{box:[5.8,.7,1]},
 state:{stock:{type:'number',min:0,max:1,default:1},prepared:{type:'bool',default:false},routineSeconds:{type:'number',min:10,max:10,default:10},text:{type:'string',max:240,default:''},lastBy:{type:'string',max:100,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 components:{surface:{height:0},sign:{lines:['Supplied timber: assemble a trail sign with empty hands (10 seconds).','Completion creates a real sign. Inspect it, then write and read your guidance.']}},
 slots:[{id:'out',kind:'surface',p:[0,0,2],yaw:0,height:0,accepts:{maxSize:[4,4,4],tags:['signage']},capacity:1},{id:'worker',kind:'stand',p:[0,0,1.25],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[{name:'assemble-sign',label:'Assemble the trail sign (10 seconds; empty hands)',params:{},then:[{op:'set',field:'routineSeconds',value:10}]}],
};
