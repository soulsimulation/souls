import type {DefInput} from '../schemas.ts';
export const LEAF_CLUMPS=['a','b','c','d'] as const;
export const LEAF_START={ax:-.25,az:-.25,bx:.25,bz:-.25,cx:-.25,cz:.25,dx:.25,dz:.25};
const position={type:'number',min:-.4,max:.4};
export const LEAF_ART_DEF:DefInput={schema:'def/1',name:'core-leaf-art',version:1,form:'point',category:'object.art',
 description:'A garden patch with twelve fallen leaves in four integral three-leaf clumps. Move a chosen clump to free local x/z coordinates from -0.4 to 0.4, or recover the initial scattered arrangement. Four completed seconds of native garden work changes the same finite material. Overlapping clumps form piles; no independent leaf custody, physics, weather or passive collection. Read current coordinates and worker; early stopping preserves the arrangement. The small work tool is a performance prop, not borrowed inventory.',
 tags:['art','garden','leaf-art','local-fixture'],synonyms:['fallen leaf art','leaf arrangement','leaf garden'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
 {kind:'box',at:[0,.025,0],size:[1.2,.05,1.2],tint:'soil',collide:true},
 ...LEAF_CLUMPS.flatMap((key,i)=>[-1,0,1].map((o)=>({kind:'extrude',at:[`$${key}x+${o*.045}`,.054+o*.003,`$${key}z+${o*.035}`],polygon:[[-.04,0],[0,.075],[.04,0],[0,-.06]],h:.004,yaw:i*.5+o*.6,tint:key,collide:false}))),
 ]}} as DefInput['make'],size:{box:[1.2,.07,1.2]},palette:{soil:'#6c6048',a:'#b9582b',b:'#c78d29',c:'#9e4c37',d:'#c2aa52'},
 params:Object.fromEntries(Object.entries(LEAF_START).map(([key,value])=>[key,{...position,default:value}])) as DefInput['params'],
 state:{...Object.fromEntries(Object.entries(LEAF_START).map(([key,value])=>[key,{...position,default:value}])),leaves:{type:'number',min:12,max:12,default:12},moves:{type:'number',min:0,max:1e9,default:0},routineSeconds:{type:'number',min:4,max:4,default:4},lastBy:{type:'string',max:80,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 slots:[{id:'worker',kind:'stand',p:[0,0,1.1],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:[{name:'arrange',label:'Arrange a chosen leaf clump at local x/z (4 seconds)',params:{clump:{type:'string',max:1,default:'a',doc:'Clump letter a, b, c or d; default a.'},x:{type:'string',max:24,default:'0',doc:'Finite decimal local x from -0.4 to 0.4; default 0.'},z:{type:'string',max:24,default:'0',doc:'Finite decimal local z from -0.4 to 0.4; default 0.'}},when:[],then:[{op:'set',field:'routineSeconds',value:4}]},{name:'recover',label:'Recover the same leaves into their initial scatter (4 seconds)',params:{},when:[],then:[{op:'set',field:'routineSeconds',value:4}]}] as DefInput['actions'],
};
