import type {DefInput} from '../schemas.ts';

/** One art-making capability with two chosen woven patterns; neither is wearable equipment. */
export const TABLE_LOOM:DefInput={
 schema:'def/1',name:'core-table-loom',version:1,form:'point',
 description:'A fixed small loom with two supplied thread portions. With empty hands, weave striped or checked cloth for ten seconds. A completed weave uses one portion and leaves a real credited portable cloth on the output tray; take it away before weaving again. Read the loom status. Early stopping leaves thread and output unchanged. Cloth may be carried and placed on a normal surface; it is not wearable equipment.',
 tags:['art','weaving','loom','local-fixture'],synonyms:['table loom','weaving loom','weave cloth'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'box',at:[0,.965,0],size:[1.2,.03,.6],tint:'wood'},
  ...[-.5,.5].flatMap(x=>[-.2,.2].map(z=>({kind:'box',at:[x,.475,z],size:[.06,.95,.06],tint:'wood'}))),
  ...[-.48,.02].map(x=>({kind:'box',at:[x,1.2,-.1],size:[.04,.44,.04],tint:'wood'})),
  ...[1,1.4].map(y=>({kind:'box',at:[-.23,y,-.1],size:[.54,.04,.04],tint:'wood'})),
  ...Array.from({length:7},(_,i)=>({kind:'box',at:[-.43+i*.065,1.2,-.075],size:[.008,.36,.008],tint:'thread'})),
  {kind:'box',at:[.35,.99,0],size:[.36,.02,.4],tint:'tray'},
  ...[1,2].map(n=>({kind:'cyl',at:[-.3+(n-1)*.2,1.02,.18],r:.05,h:.08,segments:8,tint:n===1?'blue':'cream',when:`@stock>=${n}`})),
 ]}} as DefInput['make'],palette:{wood:'#986b42',tray:'#343e41',thread:'#cbbbaa',blue:'#457e9a',cream:'#e8ce85'},params:{},size:{box:[1.2,1.42,.6]},
 state:{routineSeconds:{type:'number',min:10,max:10,default:10},stock:{type:'number',min:0,max:2,default:2},text:{type:'string',max:250,default:''},lastBy:{type:'string',max:100,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 components:{surface:{height:.98},sign:{lines:['Two supplied thread portions; choose striped or checked cloth.']}},
 slots:[{id:'out',kind:'surface',p:[.35,1,0],yaw:0,height:1,accepts:{maxSize:[.32,.08,.32],maxMass:1},capacity:1},{id:'worker',kind:'stand',p:[0,0,1.1],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:['stripes','checks'].map(pattern=>({name:`weave-${pattern}`,label:`Weave ${pattern==='stripes'?'striped':'checked'} cloth (10 seconds; empty hands)`,params:{},when:[{field:'stock',not:0}],then:[{op:'set',field:'routineSeconds',value:10}]})) as DefInput['actions'],
};
const cloth=(pattern:'striped'|'checked'):DefInput=>({
 schema:'def/1',name:`core-${pattern}-cloth`,version:1,form:'point',
 description:`A small ${pattern} woven cloth artwork. Its maker credit is recorded in its object description and on the loom status. Pick it up and place it on an ordinary surface. Not wearable clothing.`,
 tags:['art','textile','cloth','item','recorded-item'],synonyms:[`${pattern} woven cloth`,`${pattern} textile`],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'box',at:[0,.008,0],size:[.28,.016,.24],tint:'cream'},
  ...Array.from({length:5},(_,z)=>Array.from({length:6},(_,x)=>({kind:'box',at:[-.1+x*.04,.017,-.08+z*.04],size:[.038,.002,.038],tint:(pattern==='striped'?z%2:(x+z)%2)?'blue':'cream'}))).flat(),
 ]}} as DefInput['make'],palette:{cream:'#e8ce85',blue:'#457e9a'},params:{},size:{box:[.28,.05,.24]},
 components:{carryable:{mass:.12,grips:1}},
 state:{pattern:{type:'string',max:20,default:pattern},maker:{type:'string',max:100,default:''},text:{type:'string',max:250,default:''}},
} as DefInput);
export const WEAVING_DEFS:DefInput[]=[TABLE_LOOM,cloth('striped'),cloth('checked')];
