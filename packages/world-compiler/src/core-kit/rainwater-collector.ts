import type {DefInput} from '../schemas.ts';
export const RAINWATER_COLLECTOR:DefInput={schema:'def/1',name:'core-rainwater-collector',version:1,
 description:'A fixed covered rain collector with a tap and4L game capacity. Open or cover the inlet with four completed seconds of native work. In authoritative rain, collect one1L batch through four completed seconds of visible work; this is manual batch collection, never passive accumulation or scientific flow. Draw stored water into an ordinary held watering can using existing finite water transfer. Not drinking-water purification. Inspect current rainwater facts for requirements and completed credit.',
 tags:['water','camping','local-fixture'],make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
 {kind:'box',at:[0,.35,0],size:[.66,.06,.66],tint:'wood'},
 ...[-1,1].flatMap(s=>[{kind:'box',at:[s*.32,.59,0],size:[.04,.48,.66],tint:'wood'},{kind:'box',at:[0,.59,s*.32],size:[.6,.48,.04],tint:'wood'},{kind:'box',at:[s*.25,.17,-.25],size:[.07,.34,.07],tint:'dark'},{kind:'box',at:[s*.25,.17,.25],size:[.07,.34,.07],tint:'dark'}]),
 ...[0,1,2,3].map(i=>({kind:'box',at:[0,.405+i*.1,0],size:[.58,.085,.58],tint:'water',material:'water',when:'@level>'+i*.25})),
 {kind:'box',at:[0,.85,0],size:[.7,.05,.7],tint:'lid',when:'@covered=true'},
 {kind:'box',at:[0,.895,0],size:[.16,.045,.04],tint:'dark',when:'@covered=true'},
 {kind:'box',at:[0,.47,-.38],size:[.7,.7,.05],tint:'lid',when:'@covered=false'},
 {kind:'box',at:[0,.47,-.425],size:[.16,.04,.045],tint:'dark',when:'@covered=false'},
 {kind:'box',at:[0,.4,.37],size:[.07,.06,.14],tint:'metal'},
 {kind:'box',at:[0,.43,.41],size:[.13,.025,.025],tint:'metal'}]}} as DefInput['make'],
 palette:{wood:'#997047',dark:'#49392d',lid:'#5d7867',water:'#5f9abd',metal:'#8c989b'},params:{litres:{type:'number',min:4,max:4,default:4,doc:'Finite game capacity in litres'}},size:{box:[.8,.95,.9]},components:{},slots:[],
 state:{level:{type:'number',min:0,max:1,default:0},covered:{type:'bool',default:true},batches:{type:'number',min:0,max:1e9,default:0},lastBy:{type:'string',max:80,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}},
 actions:[{name:'uncover',label:'Uncover the rain collector inlet (4 seconds)',params:{},when:[{field:'covered',is:true}],then:[{op:'set',field:'covered',value:false}]},{name:'cover',label:'Cover the rain collector inlet (4 seconds)',params:{},when:[{field:'covered',is:false}],then:[{op:'set',field:'covered',value:true}]},{name:'collect-rain',label:'Collect one litre of rainwater (4 seconds; rain and open inlet required)',params:{},when:[{field:'covered',is:false}],then:[{op:'set',field:'level',value:0}]}] as DefInput['actions']};
