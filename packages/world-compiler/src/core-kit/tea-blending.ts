import type {DefInput} from '../schemas.ts';
const portion = (n=0) => ({type:'int', min:0, max:8, default:n});
const material = {green:portion(8), mint:portion(8), blendGreen:portion(), blendMint:portion(), reserveGreen:portion(), reserveMint:portion()};
const shapes:Record<string,unknown>[] = [
 {kind:'box',at:[0,.025,0],size:[.68,.05,.38],tint:'wood'},
 ...[-.24,-.08,.08,.24].flatMap(x=>[{kind:'box',at:[x,.08,-.19],size:[.012,.12,.38],tint:'wood'}]),
 {kind:'box',at:[0,.08,.19],size:[.68,.12,.012],tint:'wood'},
 {kind:'box',at:[0,.08,-.19],size:[.68,.12,.012],tint:'wood'},
 ...[['green',-.25,'green'],['mint',-.085,'mint'],['blendGreen',.085,'green'],['blendMint',.085,'mint'],['reserveGreen',.25,'green'],['reserveMint',.25,'mint']].flatMap(([field,x,tint])=>Array.from({length:8},(_,i)=>({kind:'box',at:[Number(x)+(i%2)*.045-.022,.057+Math.floor(i/2)*.013,field==='blendMint'||field==='reserveMint'?.065:-.065],size:[.055,.009,.09],tint,when:`${field}>${i}`})))
];
export const TEA_BLENDING:DefInput = {
 schema:'def/1',name:'core-tea-blending-caddy',version:1,form:'point',category:'object.tool',tags:['tea','quiet','item','recorded-item'],
 description:'Portable dry tea-blending caddy: eight green-tea and eight mint portions, a four-portion mixing well and an eight-portion mixed reserve. Choose additions as text "green mint" (for example "2 1"), then blend through three seconds of native handwork. Recover retains both actual ingredient quantities together in the mixed reserve; restore moves them back to the well, never separating pure ingredients. No brewing, drinking, scent or health simulation.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes}},palette:{wood:'#8c633f',green:'#58683c',mint:'#90ad62'},params:material,
 size:{box:[.70,.15,.40]},components:{carryable:{mass:1.2,grips:1}},
 state:{...material,recipe:{type:'string',max:7,default:'2 1'},maker:{type:'string',max:80,default:''},batches:{type:'int',min:0,max:100000,default:0},recoveries:{type:'int',min:0,max:100000,default:0},workSeconds:{type:'int',min:3,max:3,default:3},lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'int',min:-1,max:1e12,default:-1}},
 actions:[{name:'choose-additions',label:'Choose green-tea and mint portions to add',params:{text:{type:'string',max:7}},then:[{op:'set',field:'recipe',value:{param:'text'}}]},...['blend','recover','restore'].map(name=>({name,label:name==='blend'?'Blend chosen finite leaf portions (3 seconds)':name==='recover'?'Recover this mixture into the mixed reserve (3 seconds)':'Restore the actual mixed reserve to the well (3 seconds)',then:[{op:'set',field:'workSeconds',value:3}]}))]
} as unknown as DefInput;
