import type {DefInput} from '../schemas.ts';
const colors={red:'#dc3741',yellow:'#f5cd3c',blue:'#325fd2'};
const field=(max=3)=>({type:'number',min:0,max,default:0});
export const WAX_BLENDING_DEFS:DefInput[]=[{
 schema:'def/1',name:'core-wax-bench',version:1,form:'point',
 description:'Choose successive red, yellow or blue modelling-wax portions and knead each for ten seconds. Three portions of each color are supplied. Every completed knead consumes one selected portion and changes the actual persistent mixture. Mold the mixture for ten seconds to leave a real portable colored wax medallion; clear the output surface first. Read the bench for actual proportions, stock and maker. Early stopping changes no material. The displayed color is an idealized weighted average, not pigment chemistry; no heating is involved. A small cosmetic mixing spoon depicts the work; it is not a borrowed physical tool.',
 tags:['art','wax-blending','local-fixture'],synonyms:['mix colors','colored wax','knead wax'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
 {kind:'box',at:[0,.965,0],size:[1.2,.03,.7],tint:'wood'},
 ...[-.5,.5].flatMap(x=>[-.25,.25].map(z=>({kind:'box',at:[x,.475,z],size:[.06,.95,.06],tint:'wood'}))),
 {kind:'box',at:[-.16,.989,.12],size:[.4,.016,.32],tint:'mat'},
 {kind:'box',at:[-.16,1.025,.12],size:[.21,.055,.2],tint:'blend',when:'@units>0'},
 {kind:'box',at:[.36,.989,.1],size:[.32,.016,.3],tint:'tray'},
 ...Object.keys(colors).flatMap((c,i)=>[1,2,3].map(n=>({kind:'box',at:[-.4+i*.25,1.005,-.22+(n-1)*.045],size:[.13,.03,.035],tint:c,when:`@${c}Stock>=${n}`}))),
 ]}} as DefInput['make'],params:{blend:{type:'color',default:'#ddd3b6',doc:'Actual blended wax color; completed work updates this.'}},palette:{wood:'#856342',mat:'#ded5be',tray:'#746b60',blend:'#ddd3b6',...colors},size:{box:[1.2,1.06,.7]},
 state:{routineSeconds:{type:'number',min:10,max:10,default:10},...Object.fromEntries(Object.keys(colors).flatMap(c=>[[c,field()],[c+'Stock',{...field(),default:3}]])),units:field(9),text:{type:'string',max:300,default:'Mixture empty. Stock: 3 red, 3 yellow, 3 blue portions.'},lastBy:{type:'string',max:80,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 components:{surface:{height:.98},sign:{lines:['Three portions of each color; knead chosen proportions, then mold.']}},
 slots:[{id:'out',kind:'surface',p:[.36,1.005,.1],yaw:0,height:1.005,accepts:{maxSize:[.3,.12,.3],maxMass:.2},capacity:1},{id:'worker',kind:'stand',p:[-.12,0,.85],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[...Object.keys(colors).map(c=>({name:'mix-'+c,label:'Knead one '+c+' wax portion (10 seconds)',params:{},when:[{field:c+'Stock',not:0}],then:[{op:'set',field:'routineSeconds',value:10}]})),{name:'mold',label:'Mold the chosen mixture into a portable medallion (10 seconds)',params:{},when:[{field:'units',not:0}],then:[{op:'set',field:'routineSeconds',value:10}]}] as DefInput['actions'],
} as DefInput,{
 schema:'def/1',name:'core-wax-medallion',version:1,form:'point',description:'A real colored modelling-wax medallion molded from chosen portions. Its actual color, recipe and maker remain recorded in its ordinary description/state. Carry and place it on normal surfaces; it is artwork, not food, a candle or equipment.',tags:['art','wax','item','recorded-item'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[{kind:'cyl',at:[0,.02,0],r:.105,h:.04,segments:12,tint:'wax'},{kind:'cyl',at:[0,.042,0],r:.075,h:.004,segments:12,tint:'wax'}]}} as DefInput['make'],
 params:{wax:{type:'color',default:'#ddd3b6',doc:'Color derived from the recorded mixture.'}},palette:{wax:'#ddd3b6'},size:{box:[.22,.05,.22]},state:{maker:{type:'string',max:80,default:''},recipe:{type:'string',max:100,default:''},color:{type:'string',max:7,default:'#ddd3b6'}},components:{carryable:{mass:.08,grips:1}},
} as DefInput];
