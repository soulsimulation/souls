import type {DefInput} from '../schemas.ts';

export const FOLDING_DESK:DefInput={
 schema:'def/1',name:'core-folding-desk',version:1,form:'point',
 description:'A fixed paper-folding desk supplies two ivory paper sheets. Put down carried items, then choose a paper boat or folded bird and work for ten seconds with a small cosmetic creasing stylus. Completion uses one sheet and leaves one real credited portable paper sculpture on the output tray. Clear that tray before folding again. Read the desk for actual form, maker and remaining sheets. Early stopping leaves paper and output unchanged. The artworks can be carried and placed on ordinary surfaces; boats do not float and birds do not fly.',
 tags:['art','paper-folding','local-fixture'],synonyms:['origami desk','fold paper','paper sculpture'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'box',at:[0,.965,0],size:[1.2,.03,.7],tint:'wood'},
  ...[-.5,.5].flatMap(x=>[-.25,.25].map(z=>({kind:'box',at:[x,.475,z],size:[.06,.95,.06],tint:'wood'}))),
  {kind:'box',at:[.35,.99,0],size:[.4,.02,.36],tint:'tray'},
  {kind:'box',at:[-.15,.984,.14],size:[.35,.008,.32],tint:'mat'},
  ...[1,2].map(n=>({kind:'box',at:[-.15,1.001+n*.008,.14],size:[.28,.006,.28],tint:'paper',yaw:(n-1)*.04,when:`@stock>=${n}`})),
 ]}} as DefInput['make'],params:{},palette:{wood:'#8b6746',tray:'#57483e',mat:'#698e83',paper:'#f0dfb7'},size:{box:[1.2,1.05,.7]},
 state:{routineSeconds:{type:'number',min:10,max:10,default:10},stock:{type:'number',min:0,max:2,default:2},text:{type:'string',max:250,default:''},lastBy:{type:'string',max:100,default:''},lastReceipt:{type:'string',max:100,default:''},lastCompletedTick:{type:'number',min:-1,max:1e12,default:-1}} as DefInput['state'],
 components:{surface:{height:.98},sign:{lines:['Two supplied paper sheets; choose a boat or folded bird.']}},
 slots:[{id:'out',kind:'surface',p:[.35,1.01,0],yaw:0,height:1.01,accepts:{maxSize:[.36,.26,.32],maxMass:.1},capacity:1},{id:'worker',kind:'stand',p:[-.05,0,.85],yaw:Math.PI,accepts:{tags:['body']},capacity:1}],
 actions:['boat','bird'].map(form=>({name:`fold-${form}`,label:`Fold a paper ${form} (10 seconds; creasing stylus)`,params:{},when:[{field:'stock',not:0}],then:[{op:'set',field:'routineSeconds',value:10}]})) as DefInput['actions'],
} as DefInput;
const common={schema:'def/1',version:1,form:'point',tags:['art','paper','item','recorded-item'],params:{},palette:{paper:'#f0dfb7',fold:'#d1b77e'},components:{carryable:{mass:.012,grips:1}}};
const boat:DefInput={...common,name:'core-paper-boat',
 description:'An ivory folded-paper boat artwork with a creased central ridge and two folded sides. Its maker credit is in its ordinary object description and the folding desk status. Carry it and place it on a normal surface. It is a paper sculpture, not a vessel or floating vehicle.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'box',at:[0,.004,0],size:[.25,.008,.09],tint:'fold'},
  ...[-1,1].map(s=>({kind:'box',at:[0,.045,s*.055],size:[.25,.09,.006],pitch:s*.4,tint:'paper'})),
  {kind:'extrude',at:[0,0,0],polygon:[[-.11,0],[.11,0],[0,.12]],h:.006,pitch:-Math.PI/2,tint:'paper'},
  ...[-1,1].map(s=>({kind:'box',at:[s*.11,.035,0],size:[.006,.07,.11],roll:s*.45,tint:'paper'})),
 ]}} as DefInput['make'],size:{box:[.3,.13,.18]},state:{form:{type:'string',max:20,default:'boat'},maker:{type:'string',max:100,default:''},text:{type:'string',max:250,default:''}},
} as DefInput;
const bird:DefInput={...common,name:'core-paper-bird',
 description:'An ivory folded-paper bird artwork: a creased body, two triangular wings, pointed tail and folded neck and beak. Its maker credit is in its ordinary object description and the folding desk status. Carry it and place it on a normal surface. It is a paper sculpture and does not fly.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'extrude',at:[0,.01,0],polygon:[[-.025,-.06],[.025,-.06],[.04,.04],[0,.09],[-.04,.04]],h:.06,tint:'fold'},
  ...[-1,1].map(s=>({kind:'extrude',at:[0,.09,0],polygon:[[s*.02,0],[s*.15,-.09],[s*.14,.09]],h:.006,roll:s*.4,tint:'paper'})),
  {kind:'box',at:[0,.14,.075],size:[.016,.15,.016],pitch:.45,tint:'paper'},
  {kind:'extrude',at:[0,.21,.105],polygon:[[-.015,0],[.015,0],[0,.045]],h:.008,tint:'paper'},
  {kind:'extrude',at:[0,.07,-.06],polygon:[[-.025,0],[0,-.065],[.025,0]],h:.006,pitch:-.7,tint:'paper'},
 ]}} as DefInput['make'],size:{box:[.34,.24,.3]},state:{form:{type:'string',max:20,default:'bird'},maker:{type:'string',max:100,default:''},text:{type:'string',max:250,default:''}},
} as DefInput;
export const PAPER_FOLDING_DEFS:DefInput[]=[FOLDING_DESK,boat,bird];
