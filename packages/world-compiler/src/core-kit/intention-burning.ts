import type {DefInput} from '../schemas.ts';

// One finite paper ritual, using the existing action-specific writing and fire contacts.
export const INTENTION_BURNER:DefInput={
 schema:'def/1',name:'core-intention-burner',version:1,form:'point',
 description:'A fixed metal intention-burning stand holds one supplied paper sheet. Write your own short words by hand, then read them. Light the lower edge to release those words: at native contact the paper becomes spent charred material and a small flame burns in the tray. Put it out afterwards. Anyone with normal access may operate this shared stand. The words and status are read through the sign route; drawn lettering is not promised. Spent paper cannot be rewritten or relit. Earlier words may remain in world history; this is not secure erasure. No refill, removable output, fire spread or mental-state effect is implied.',
 tags:['ritual','paper','hand-writable','hand-operated','local-fixture'],synonyms:['intention paper','burn a wish','release words'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'cyl',at:[0,.02,0],r:.23,h:.04,segments:8,tint:'metal'},
  ...[-.17,.17].map(x=>({kind:'box',at:[x,.49,0],size:[.035,.94,.035],tint:'metal'})),
  {kind:'box',at:[0,.99,.02],size:[.48,.035,.38],tint:'metal'},
  {kind:'box',at:[0,1.015,-.16],size:[.48,.05,.02],tint:'metal'},
  ...[-.23,.23].map(x=>({kind:'box',at:[x,1.015,.02],size:[.02,.05,.38],tint:'metal'})),
  ...[-.17,.17].map(x=>({kind:'box',at:[x,1.15,0],size:[.012,.3,.012],tint:'metal'})),
  {kind:'box',at:[0,1.15,.02],size:[.34,.28,.006],tint:'paper',when:'!@spent'},
  {kind:'box',at:[-.055,1.021,.015],size:[.15,.008,.14],yaw:.3,tint:'ash',when:'@spent'},
  {kind:'box',at:[.055,1.027,.055],size:[.13,.006,.13],yaw:-.45,tint:'char',when:'@spent'},
  {kind:'box',at:[0,1.025,.12],size:[.025,.012,.025],tint:'valve'},
  {kind:'cone',at:[0,1.07,.08],r:.025,h:.1,segments:6,tint:'flame',glow:1,role:'flame',pivot:[0,1.02,.08],when:'@on'},
 ],faces:[{at:[0,1.15,.025],w:.3,h:.24,bg:'#f1e4c5',ink:'#2b2925'}]}} as DefInput['make'],
 params:{},palette:{metal:'#4d4840',paper:'#f1e4c5',ash:'#817d73',char:'#302d28',valve:'#3a3028',flame:'#ffb257'},size:{box:[.5,1.32,.42]},
 components:{sign:{lines:['One blank intention paper. Write words before lighting.']},light:{color:'#ffba73',range:1.5,on:true,at:[0,1.1,.08]}},
 state:{on:{type:'bool',default:false},spent:{type:'bool',default:false},text:{type:'string',max:100,default:''},textBy:{type:'string',max:40,default:''}},
 actions:[
  {name:'write',label:'Write an intention on the supplied paper',params:{text:{type:'string',max:100,doc:'your words, up to100 characters and three lines'}},when:[{field:'spent',is:false},{field:'on',is:false}],then:[{op:'set',field:'text',value:{param:'text'}}]},
  {name:'erase',label:'Wipe the unburned intention paper',when:[{field:'spent',is:false},{field:'on',is:false},{field:'text',not:''}],then:[{op:'set',field:'text',value:''},{op:'set',field:'textBy',value:''}]},
  {name:'light',label:'Burn the written intention paper',when:[{field:'spent',is:false},{field:'on',is:false},{field:'text',not:''}],then:[{op:'set',field:'on',value:true},{op:'set',field:'spent',value:true},{op:'set',field:'text',value:'Intention paper spent; words released to charred material.'},{op:'set',field:'textBy',value:''}]},
  {name:'put-out',label:'Put out the intention tray',when:[{field:'on',is:true}],then:[{op:'set',field:'on',value:false},{op:'set',field:'text',value:'Intention paper spent; words released. The fire is out.'}]},
 ] as DefInput['actions'],
} as DefInput;
