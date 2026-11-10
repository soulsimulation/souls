import type {DefInput} from '../schemas.ts';
export const CHALK_COLOURS = ['red','blue','yellow'] as const;
export type ChalkLine = {x1:number;z1:number;x2:number;z2:number;colour:typeof CHALK_COLOURS[number];maker:string};
/** One bounded public composition, shared by the observer and completion helper. Null means invalid, not blank. */
export function chalkLines(value:unknown):ChalkLine[]|null {
 try {const a=JSON.parse(typeof value==='string'?value:'[]');if(!Array.isArray(a)||a.length>8)return null;
  return a.every(s=>s&&['x1','z1','x2','z2'].every(k=>typeof s[k]==='number'&&Number.isFinite(s[k])&&Math.abs(s[k])<=.45)&&Math.hypot(s.x2-s.x1,s.z2-s.z1)>=.03&&CHALK_COLOURS.includes(s.colour)&&typeof s.maker==='string'&&s.maker.length<=80)?a:null;
 }catch{return null;}
}
export const PAVEMENT_CHALK:DefInput={schema:'def/1',name:'core-pavement-lines',version:1,category:'object.art',form:'point',tags:['art','chalk','pavement'],
 description:'A real grounded pavement patch for your own chalk composition. Select a line using text: x1,z1 x2,z2 colour; coordinates -0.45 to 0.45 metres, red/blue/yellow. Complete ground work to draw it. Up to eight current strokes, eight charges of each colour. Select a current stroke number and erase only that mark. Inspect actual endpoints, colours and makers. No terrain editing or fading.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[{kind:'box',at:[0,.012,0],size:[1,.024,1],tint:'stone',round:0},...CHALK_COLOURS.map((tint,i)=>({kind:'box',at:[-.35+i*.09,.038,.43],size:[.06,.025,.025],tint,round:0,when:`@${tint}>0`}))]}},
 params:{stone:{type:'color',default:'#858b91'}},palette:{stone:'#858b91',red:'#ed5862',blue:'#5da5f5',yellow:'#f5d95d'},size:{box:[1,.06,1]},
 state:{lines:{type:'string',max:2000,default:'[]'},selection:{type:'string',max:100,default:'-0.35,-0.3 0.3,0.25 red'},erase:{type:'string',max:1,default:'1'},...Object.fromEntries(CHALK_COLOURS.map(c=>[c,{type:'int',min:0,max:8,default:8}])),routineSeconds:{type:'int',min:4,max:4,default:4},lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'int',min:-1,max:1e12,default:-1}},
 actions:[{name:'choose-line',label:'Choose free endpoints and chalk colour',params:{text:{type:'string',max:100,doc:'x1,z1 x2,z2 red/blue/yellow; each coordinate -0.45..0.45 metres'}},then:[{op:'set',field:'selection',value:{param:'text'}}]},
 {name:'choose-stroke',label:'Choose a current stroke number to erase',params:{text:{type:'string',max:1,doc:'Current stroke number 1..8 from inspection'}},then:[{op:'set',field:'erase',value:{param:'text'}}]},
 ...['draw-line','erase-stroke'].map(name=>({name,label:name==='draw-line'?'Draw selected chalk line (4 seconds, one colour charge)':'Erase selected current stroke (4 seconds)',then:[{op:'set',field:'routineSeconds',value:4}]}))],
} as unknown as DefInput;
