import type {DefInput} from '../schemas.ts';
const cells=[['bl','back-left',-.14,-.105],['br','back-right',.14,-.105],['fl','front-left',-.14,.105],['fr','front-right',.14,.105]] as const;
export const SAND_GARDEN_DEF:DefInput={
 schema:'def/1',name:'core-sand-garden',version:1,form:'point',description:'A quiet tabletop sand garden with four independently brushed cells. Choose lengthwise or across furrows for any cell, composing a lasting pattern; smooth the whole bed to remove them. Directions and front/back are local to the bed, with its worker side at the front. Each ten-second completed native brush work changes the same sand and readable worker record; early stopping preserves it. Read for actual cell pattern. A small cosmetic brush depicts the work, not borrowed physical-tool custody. No meditation/mental-state, separable material or downstream painting behavior is implied.',
 tags:['art','quiet-ritual','sand-garden','local-fixture'],synonyms:['brush sand','sand furrows','quiet garden'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
 {kind:'box',at:[0,.965,0],size:[.85,.03,.65],tint:'wood'},...[-.34,.34].flatMap(x=>[-.24,.24].map(z=>({kind:'box',at:[x,.475,z],size:[.06,.95,.06],tint:'wood'}))),
 {kind:'box',at:[0,1,0],size:[.62,.02,.46],tint:'sand'},...[-.325,.325].map(x=>({kind:'box',at:[x,1.012,0],size:[.025,.065,.51],tint:'wood'})),...[-.245,.245].map(z=>({kind:'box',at:[0,1.012,z],size:[.67,.065,.025],tint:'wood'})),
 ...cells.flatMap(([key,,x,z])=>[-.025,.025].flatMap(o=>[
 {kind:'box',at:[x+o,1.018,z],size:[.014,.016,.16],tint:'ridge',when:`@${key}>0&@${key}<2`},
 {kind:'box',at:[x,1.018,z+o],size:[.22,.016,.014],tint:'ridge',when:`@${key}>=2`},
 ])),
 ]}} as DefInput['make'],palette:{wood:'#856342',sand:'#bdae7e',ridge:'#dfcf9a'},size:{box:[.85,1.06,.65]},
 state:{...Object.fromEntries(cells.map(([c])=>[c,{type:'number',min:0,max:2,default:0}])),marked:{type:'number',min:0,max:4,default:0},routineSeconds:{type:'number',min:10,max:10,default:10},text:{type:'string',max:300,default:'All four sand cells are smooth. Brush chosen cells lengthwise or across; read for the actual pattern.'},lastBy:{type:'string',max:80,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 components:{sign:{lines:['Brush chosen cells into furrows, or smooth the same sand.']}},
 slots:[{id:'worker',kind:'stand',p:[0,0,.8],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[...cells.flatMap(([c,label])=>[['along','lengthwise',1],['across','across',2]].map(([a,word,value])=>({name:`brush-${c}-${a}`,label:`Brush ${label} sand ${word} (10 seconds)`,params:{},when:[{field:c,not:value}],then:[{op:'set',field:'routineSeconds',value:10}]}))),{name:'smooth',label:'Smooth all four sand cells (10 seconds)',params:{},when:[{field:'marked',not:0}],then:[{op:'set',field:'routineSeconds',value:10}]}] as DefInput['actions'],
};
