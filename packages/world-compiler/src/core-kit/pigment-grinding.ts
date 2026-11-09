import type {DefInput} from '../schemas.ts';
export const PIGMENT_GRINDING_DEF:DefInput={
 schema:'def/1',name:'core-pigment-tray',version:1,form:'point',
 description:'Work supplied soft artist chalk into pigment. Crush the visible chunks for ten seconds to make coarse granules; grind for another ten seconds to make fine powder. Each completed native work changes the same persistent material in this fixed tray. Early stopping changes nothing. Read the tray for its actual material stage and latest worker. A small cosmetic hand tool depicts the work, not a borrowed physical tool. No dust inhalation, chemistry, separable powder or downstream painting-consumption behavior is claimed.',
 tags:['art','pigment-grinding','local-fixture'],synonyms:['crush chalk','grind pigment','artist pigment'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
 {kind:'box',at:[0,.965,0],size:[.95,.03,.65],tint:'wood'},
 ...[-.38,.38].flatMap(x=>[-.23,.23].map(z=>({kind:'box',at:[x,.475,z],size:[.06,.95,.06],tint:'wood'}))),
 {kind:'box',at:[0,.998,.08],size:[.55,.036,.36],tint:'stone'},
 ...[-.26,.26].map(x=>({kind:'box',at:[x,1.04,.08],size:[.025,.06,.36],tint:'stone'})),
 ...[-.09,.25].map(z=>({kind:'box',at:[0,1.04,z],size:[.55,.06,.025],tint:'stone'})),
 ...[-.15,0,.15].map((x,i)=>({kind:'box',at:[x,1.055,.04+(i%2)*.08],size:[.1,.075,.075],yaw:i*.4,tint:'pigment',when:'@stage<=0'})),
 ...[-.18,-.06,.06,.18].flatMap((x,i)=>[-.015,.09,.18].map((z,j)=>({kind:'box',at:[x,1.034,z],size:[.047,.028,.04],yaw:(i+j)*.3,tint:'pigment',when:'@stage>0&@stage<2'}))),
 {kind:'box',at:[0,1.025,.08],size:[.43,.016,.23],tint:'pigment',when:'@stage>=2'},
 ]}} as DefInput['make'],palette:{wood:'#856342',stone:'#73737a',pigment:'#ce694d'},size:{box:[.95,1.1,.65]},
 state:{stage:{type:'number',min:0,max:2,default:0},routineSeconds:{type:'number',min:10,max:10,default:10},text:{type:'string',max:300,default:'Supplied soft artist chalk chunks. Crush for coarse pigment, then grind for fine powder.'},lastBy:{type:'string',max:80,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}},
 components:{sign:{lines:['Supplied artist chalk: chunks, coarse pigment, then fine powder.']}},
 slots:[{id:'worker',kind:'stand',p:[0,0,.85],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[{name:'crush',label:'Crush supplied chalk into coarse pigment (10 seconds)',params:{},when:[{field:'stage',is:0}],then:[{op:'set',field:'routineSeconds',value:10}]},{name:'grind',label:'Grind coarse pigment into fine powder (10 seconds)',params:{},when:[{field:'stage',is:1}],then:[{op:'set',field:'routineSeconds',value:10}]}],
};
