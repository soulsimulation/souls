// Opt-in harvest-to-food: old baskets/harvest faculty retain their bytes and behaviour.
import type {DefInput} from '../schemas.ts';
import {HARVEST_DEFS} from './harvest.ts';
const basket=structuredClone(HARVEST_DEFS.find(d=>d.name==='core-harvest-basket')!);
const shapes=(basket.make as unknown as {args:{shapes:Record<string,unknown>[]}}).args.shapes;
// This new revision budgets every stored fruit, including the full basket.
for(const s of shapes){if(s.kind==='lathe')s.segments=6;if(s.kind==='sphere')s.segments=4;}
export const PRODUCE_BASKET:DefInput={...basket,version:2,category:'object.decor',
 description:'A harvest basket for up to six ripe tomatoes. Use ordinary harvest at a fruiting planter. Put it on a fixed admitted work surface with room 30 cm to its right; prepare one tomato to make a real portable food beside it, consuming one stored fruit after native work. Pick up and eat the tomato normally.',
 state:{...basket.state,lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'number',default:-1}},
 actions:[...(basket.actions??[]),{name:'take-tomato',label:'Prepare one real edible tomato beside the harvest basket',then:[{op:'set',field:'lastReceipt',value:''}]}],
}as DefInput;
export const TOMATO:DefInput={schema:'def/1',name:'core-tomato',version:1,category:'object.decor',form:'point',
 description:'A ripe red garden tomato. Carry it and eat it from the hand in two bites; only the green calyx remains afterward. Its own provenance identifies the harvested basket and preparer.',
 tags:['garden','kitchen','item','food','edible','recorded-item'],synonyms:['tomato','ripe tomato'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
 {kind:'lathe',at:[0,0,0],profile:[[0,0],[.03,.002],[.045,.024],[.04,.06],[.018,.073],[0,.07]],segments:8,tint:'skin',when:'@left>0.6'},
 {kind:'lathe',at:[0,0,0],profile:[[0,0],[.03,.002],[.045,.024],[.04,.042],[0,.042]],segments:8,tint:'skin',when:'@left>0.05&@left<=0.6'},
 {kind:'cyl',at:[0,.043,0],r:.035,h:.003,segments:8,tint:'flesh',when:'@left>0.05&@left<=0.6'},
 {kind:'box',at:[0,.074,0],size:[.035,.006,.012],round:0,tint:'leaf',when:'@left>0.05'},
 {kind:'box',at:[0,.005,0],size:[.035,.006,.012],round:0,tint:'leaf',when:'@left<=0.05'}]}},
 params:{skin:{type:'color',default:'#dc3d25',doc:'ripe red skin'},flesh:{type:'color',default:'#ec8260',doc:'cut flesh'},leaf:{type:'color',default:'#487b33',doc:'green calyx'}},palette:{skin:'#dc3d25',flesh:'#ec8260',leaf:'#487b33'},
 state:{left:{type:'number',min:0,max:1,default:1},bites:{type:'number',min:1,max:8,default:2}},components:{carryable:{mass:.12,grips:1}},size:{box:[.09,.08,.09]},
 actions:[{name:'eat',label:'Eat the tomato',then:[{op:'set',field:'left',value:0}]},{name:'bite',label:'Take a bite of the tomato',then:[{op:'set',field:'left',value:0}]}],
}as DefInput;
export const GARDEN_PRODUCE_DEFS=[PRODUCE_BASKET,TOMATO];
