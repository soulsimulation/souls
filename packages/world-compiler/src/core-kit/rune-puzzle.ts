import type {DefInput} from '../schemas.ts';

const cells=['northwest','north','northeast','southwest','south','southeast'];
const cross=(i:number)=>cells.flatMap((_,j)=>Math.abs(i%3-j%3)+Math.abs(Math.floor(i/3)-Math.floor(j/3))<=1?[j]:[]);
const initial=cells.map((_,i)=>[0,2,4].filter(j=>cross(j).includes(i)).length%2===1);
const rules='Wave at a tile to flip it and its orthogonal neighbors. Make all six dark, then claim the solved round. Reset restores the same puzzle; wins remain.';
const reset=cells.map((field,i)=>({op:'set' as const,field,value:initial[i]}));

/** A solo world puzzle on ordinary admitted declarative actions, not physical buttons. */
export const RUNE_PUZZLE: DefInput={
 schema:'def/1',name:'core-rune-puzzle',version:1,form:'point',
 description:'A gesture-operated two-by-three cross-toggle rune puzzle. '+rules+' Amber means on. The bottom stripe turns green after a correctly claimed solution. Gestures use ordinary admitted object effects, not physical button contact.',
 tags:['game','puzzle','rune-board','local-fixture'],synonyms:['rune puzzle','cross toggle','solo puzzle'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  ...[-.47,.47].map(x=>({kind:'box',at:[x,.71,0],size:[.06,1.42,.06],tint:'frame'})),
  ...[-.47,.47].map(x=>({kind:'box',at:[x,.025,0],size:[.12,.05,.45],tint:'frame'})),
  {kind:'box',at:[0,1.08,0],size:[1,.86,.06],tint:'frame'},
  ...cells.flatMap((field,i)=>[
   {kind:'box',at:[(i%3-1)*.27,1.12+(.5-Math.floor(i/3))*.25,.04],size:[.21,.18,.025],tint:'dark',when:`!@${field}`},
   {kind:'box',at:[(i%3-1)*.27,1.12+(.5-Math.floor(i/3))*.25,.04],size:[.21,.18,.025],tint:'lit',glow:.65,when:`@${field}`},
  ]),
  {kind:'box',at:[0,.72,.04],size:[.75,.04,.025],tint:'won',glow:.4,when:'@solved'},
 ]}} as DefInput['make'],palette:{frame:'#69523a',dark:'#292c37',lit:'#ffbf48',won:'#7add8d'},params:{},size:{box:[1,1.51,.45]},
 state:{...Object.fromEntries(cells.map((k,i)=>[k,{type:'bool',default:initial[i]}])),solved:{type:'bool',default:false},wins:{type:'number',min:0,max:1000000,default:0},rules:{type:'string',max:180,default:rules}} as DefInput['state'],components:{},slots:[],
 actions:[
  ...cells.map((field,i)=>({name:'wave-'+field,label:`Wave at ${field}: flip this tile and its orthogonal neighbors`,params:{},when:[{field:'solved',is:false}],then:cross(i).map(j=>({op:'toggle',field:cells[j]}))})),
  {name:'claim-solved',label:'Claim solved round (all six tiles must be dark)',params:{},when:[{field:'solved',is:false},...cells.map(field=>({field,is:false}))],then:[{op:'set',field:'solved',value:true},{op:'increment',field:'wins',by:1}]},
  {name:'reset',label:'Reset the puzzle; retain completed rounds',params:{},then:[...reset,{op:'set',field:'solved',value:false},{op:'set',field:'rules',value:rules}]},
 ] as DefInput['actions'],
};
