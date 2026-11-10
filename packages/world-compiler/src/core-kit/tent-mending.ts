// Camping canvas uses the existing repair faculty; frozen tent revisions remain intact.
import type {DefInput} from '../schemas.ts';
import {TENT_FLAP} from './hand-openings.ts';

type Shape = Record<string, unknown> & {kind:string; at:number[]; size?:number[]};
const tent=structuredClone(TENT_FLAP) as DefInput & {make:{args:{shapes:Shape[]}}};
const flap=tent.make.args.shapes.find(s=>s.role==='door'&&s.tint==='flap')!;
// A rectangular tear remains open until repair completes. All fragments retain the
// original flap's role and hinge, so opening the damaged flap still moves one leaf.
const fragments=[
  {at:[0,.3125,1.12],size:[1,.575,.03]},
  {at:[0,.9875,1.12],size:[1,.175,.03]},
  {at:[-.33,.75,1.12],size:[.34,.3,.03]},
  {at:[.33,.75,1.12],size:[.34,.3,.03]},
].map(part=>({...flap,...part,when:'@broken'}));
tent.make.args.shapes=tent.make.args.shapes.flatMap(s=>s===flap?[{...s,when:'!@broken'},...fragments]:[s]);

export const MENDABLE_TENT:DefInput={...tent,version:3,
  description:'A two-person ridge or dome tent with a hand-operated canvas flap. A Soul mends a torn flap with a sewing awl; the tear stays open until repair finishes. Its interior mat is decorative: lying inside is not currently available.',
  state:{...tent.state,broken:{type:'bool',default:false},repairedBy:{type:'string',max:80,default:''}},
  components:{...tent.components,repairable:{tool:'sewing-awl',label:'Mend the torn tent canvas with a sewing awl',says:'torn canvas',hand:[0,.75,1.18],stands:[[0,1.9],[-.3,1.9],[.3,1.9]],strokes:6,lift:.06,motion:'pump'}},
} as DefInput;

export const SEWING_AWL:DefInput={schema:'def/1',name:'core-sewing-awl',version:1,
  description:'A short wooden-handled sewing awl for mending torn tent canvas. A Soul carries it, works the point back and forth at the tear, and keeps it after mending.',
  tags:['tool','item','sewing-awl','tool-sewing-awl','recorded-item'],form:'point',
  make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
    {kind:'box',at:[.015,.035,0],size:[.1,.045,.04],round:.008,tint:'wood'},
    {kind:'cyl',at:[.065,.035,0],r:.012,h:.012,segments:6,roll:Math.PI/2,tint:'steel'},
    {kind:'cone',at:[.105,.035,0],r:.006,h:.07,segments:5,roll:-Math.PI/2,tint:'steel'},
  ]}},
  params:{wood:{type:'color',default:'#9c6338',doc:'wooden handle colour'},steel:{type:'color',default:'#aeb7bf',doc:'steel point colour'}},palette:{wood:'#9c6338',steel:'#aeb7bf'},
  components:{carryable:{mass:.12,grips:1}},layer:'decor',size:{box:[.18,.06,.04]},
} as DefInput;
