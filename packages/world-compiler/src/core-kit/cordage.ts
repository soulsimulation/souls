import type {DefInput} from '../schemas.ts';
const box=(at:number[],size:number[],tint:string,when?:string)=>({kind:'box',at,size,tint,round:0,...(when?{when}:{})});
const board:DefInput={schema:'def/1',name:'core-cordage-board',version:1,form:'point',tags:['camping','cordage','local-fixture'],
 description:'A fixed cordage board with one reusable binding. Work ten seconds with empty hands to prepare the same loose camp cord as a loop or bundled guyline. Return the prepared cord here and untie it to recover loose cord and its binding. No load-bearing or tent attachment.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[...[-.46,.46].flatMap(x=>[-.25,.25].map(z=>box([x,.46,z],[.07,.92,.07],'wood'))),box([0,.94,0],[1.1,.04,.7],'wood'),box([.2,.98,0],[.6,.04,.5],'board'),box([-.35,.98,0],[.17,.04,.2],'tray'),box([-.35,1.01,0],[.08,.02,.14],'binding','@bindings=1')]}},
 params:{wood:{type:'color',default:'#79553b'},board:{type:'color',default:'#c3a077'},tray:{type:'color',default:'#e9e1c8'},binding:{type:'color',default:'#42696e'}},palette:{wood:'#79553b',board:'#c3a077',tray:'#e9e1c8',binding:'#42696e'},
 state:{bindings:{type:'int',min:0,max:1,default:1},routineSeconds:{type:'int',min:10,max:10,default:10},text:{type:'string',max:160,default:''},lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'int',min:-1,max:1e12,default:-1}},
 slots:[{id:'cord',kind:'surface',p:[.2,1,0],yaw:0,height:1,accepts:{maxSize:[.42,.08,.32],maxMass:1},capacity:1,label:'cord board'},{id:'worker',kind:'stand',p:[.2,0,.8],yaw:Math.PI}],components:{surface:{height:1}},size:{box:[1.1,1.02,.7]},
 actions:[{name:'tie-loop',label:'Prepare cord loop (10 seconds, binding, empty hands)'},{name:'tie-guyline',label:'Bundle camp guyline (10 seconds, binding, empty hands)'},{name:'untie',label:'Untie camp cord and recover binding (10 seconds, empty hands)'}].map(a=>({...a,then:[{op:'set',field:'routineSeconds',value:10}]})),
} as unknown as DefInput;
const cord:DefInput={schema:'def/1',name:'core-camp-cord',version:1,form:'point',tags:['camping','item','recorded-item'],
 description:'Real portable camp cord: loose, bound loop or bundled guyline. Its current form and maker persist while carried. A cordage board prepares or undoes its binding; no rope physics, tension, load-bearing or tent attachment.',
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  ...[-.1,.02,.14].map(z=>box([0,.012,z],[.36,.024,.018],'cord','@form=0')),
  box([-.17,.012,-.04],[.018,.024,.12],'cord','@form=0'),box([.17,.012,.08],[.018,.024,.12],'cord','@form=0'),
  ...[-.15,.15].map(x=>box([x,.012,0],[.024,.024,.26],'cord','@form=1')),
  ...[-.12,.12].map(z=>box([0,.012,z],[.3,.024,.024],'cord','@form=1')),
  box([0,.03,-.12],[.07,.024,.05],'binding','@form=1'),
  ...[-.08,-.04,0,.04,.08].map(z=>box([0,.012,z],[.36,.024,.018],'cord','@form=2')),
  ...[-.17,.17].map(x=>box([x,.012,0],[.018,.024,.16],'cord','@form=2')),
  box([0,.03,0],[.06,.024,.2],'binding','@form=2'),
 ]}},params:{cord:{type:'color',default:'#dbab48'},binding:{type:'color',default:'#42696e'}},palette:{cord:'#dbab48',binding:'#42696e'},state:{form:{type:'int',min:0,max:2,default:0},text:{type:'string',max:160,default:''}},components:{carryable:{mass:.25,grips:1}},size:{box:[.4,.06,.3]},
} as unknown as DefInput;
export const CORDAGE:DefInput[]=[board,cord];
