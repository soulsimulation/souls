import type {DefInput} from '../schemas.ts';

// Separate, ordinary portable items: the composition is the placed entities, not a preset or a saved drawing.
const stone = (name:string, description:string, size:[number,number,number], color:string, mass:number):DefInput => ({
  schema:'def/1',name,version:1,description,
  tags:['item','stone','land-art','recorded-item'],synonyms:['stone','rock','land art material'],form:'point',layer:'decor',
  make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
    {kind:'sphere',at:[0,size[1]/2,0],r:.1,scale:size.map(n=>n/.2),segments:7,tint:'stone'},
  ]}},
  params:{stone:{type:'color',default:color,doc:'stone colour'}},palette:{stone:color},
  components:{carryable:{mass,grips:1}},size:{box:size},
} as unknown as DefInput);

export const LAND_ART_MATERIALS:DefInput[] = [
  stone('core-smooth-stone','A small rounded grey stone (16 cm). Pick it up, carry it and put it on clear ground; arrange it with other stones and wood, then move it again.',[.16,.1,.13],'#858b8b',.6),
  stone('core-flat-stone','A flat ochre stone (20 cm). A separate carryable piece for arranging and rearranging on clear ground.',[.2,.055,.14],'#b19a74',.7),
  {
    schema:'def/1',name:'core-driftwood-piece',version:1,
    description:'A short weathered piece of wood (29 cm), light enough for one hand. Carry it to clear ground and arrange it with stones or other wood; pick it up again to change the composition.',
    tags:['item','wood','land-art','recorded-item'],synonyms:['driftwood','wood piece','stick','land art material'],form:'point',layer:'decor',
    make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
      {kind:'cyl',at:[0,.032,0],r:.03,r2:.024,h:.28,segments:7,roll:Math.PI/2,tint:'wood'},
      {kind:'cyl',at:[-.142,.032,0],r:.024,h:.004,segments:7,roll:Math.PI/2,tint:'end'},
      {kind:'cyl',at:[.142,.032,0],r:.03,h:.004,segments:7,roll:Math.PI/2,tint:'end'},
    ]}},
    params:{wood:{type:'color',default:'#8f7d64',doc:'weathered wood colour'},end:{type:'color',default:'#b6a58b',doc:'cut end colour'}},
    palette:{wood:'#8f7d64',end:'#b6a58b'},components:{carryable:{mass:.15,grips:1}},size:{box:[.288,.064,.06]},
  } as unknown as DefInput,
];
