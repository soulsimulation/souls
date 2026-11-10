import type {DefInput} from '../schemas.ts';
const box=(at:number[],size:number[],tint:string,when?:string)=>({kind:'box',at,size,tint,round:0,...(when?{when}:{})});
const desk:DefInput={schema:'def/1',name:'core-field-writing-desk',version:1,form:'point',tags:['camping','writing','local-fixture'],
 description:'A fixed camp writing desk with five ink charges. Put a field journal on its journal surface, draft a short entry on the journal, then append it with ten seconds of native writing and empty hands. Earlier entries stay unchanged.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[...[-.43,.43].flatMap(x=>[-.23,.23].map(z=>box([x,.48,z],[.06,.96,.06],'wood'))),box([0,.98,0],[1,.04,.65],'wood'),box([-.34,1.035,-.14],[.12,.07,.12],'ink')]}},
 params:{wood:{type:'color',default:'#84603e'},ink:{type:'color',default:'#263646'}},palette:{wood:'#84603e',ink:'#263646'},
 state:{ink:{type:'int',min:0,max:5,default:5},routineSeconds:{type:'int',min:10,max:10,default:10},lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'int',min:-1,max:1e12,default:-1}},
 slots:[{id:'journal',kind:'surface',p:[.12,1,0],height:1,yaw:0,accepts:{maxSize:[.5,.09,.36],maxMass:1},capacity:1,label:'journal writing surface'},{id:'writer',kind:'stand',p:[.12,0,1],yaw:Math.PI}],components:{surface:{height:1}},size:{box:[1,1.07,.65]},
 actions:[{name:'append-entry',label:'Append the journal draft (10 seconds, one ink, empty hands)',then:[{op:'set',field:'routineSeconds',value:10}]}],
} as unknown as DefInput;
const journal:DefInput={schema:'def/1',name:'core-field-journal',version:1,form:'point',tags:['camping','writing','item','recorded-item'],
 description:'A portable open field journal. Draft up to 100 characters, then put this same journal on a supplied writing desk to append the draft. Five chronological signed entries persist; old entries cannot be edited. Inspect the actual full history after carrying it elsewhere. This is not private memory or automatic dating.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[box([0,.009,0],[.44,.018,.3],'cover'),box([0,.025,0],[.42,.014,.28],'page'),box([0,.035,0],[.008,.006,.28],'cover'),...Array.from({length:5},(_,n)=>Array.from({length:n+1},(_,i)=>box([.1,.034,-.09+i*.04],[.15,.004,.008],'ink',`@count=${n+1}`))).flat()]}},
 params:{cover:{type:'color',default:'#633c2d'},page:{type:'color',default:'#f1e3be'},ink:{type:'color',default:'#273749'}},palette:{cover:'#633c2d',page:'#f1e3be',ink:'#273749'},
 state:{draft:{type:'string',max:100,default:''},history:{type:'string',max:2000,default:'[]'},count:{type:'int',min:0,max:5,default:0}},components:{carryable:{mass:.35,grips:1}},size:{box:[.46,.06,.32]},
 actions:[{name:'draft-entry',label:'Draft the next journal entry (append it at a writing desk)',params:{entry:{type:'string',max:100,doc:'The next entry, up to 100 characters. A draft is not a completed history entry.'}},then:[{op:'set',field:'draft',value:{param:'entry'}}]}],
} as unknown as DefInput;
export const FIELD_JOURNAL:DefInput[]=[desk,journal];
