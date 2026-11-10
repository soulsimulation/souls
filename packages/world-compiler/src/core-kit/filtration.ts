import type {DefInput} from '../schemas.ts';
const history={lastBy:{type:'string',max:80,default:''},lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'number',default:-1}};
export const CAMP_WATER_FILTER:DefInput={schema:'def/1',name:'core-camp-water-filter',version:1,category:'object.decor',form:'point',description:'A finite camp hand-pump filter: three supplied cloudy portions, two uses in the installed cartridge and one spare. Completed native work fills a selected real carafe. Simulated clarity, not potability or drinking safety.',tags:['camping','water-filter','local-fixture'],make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
 {kind:'box',at:[0,.04,0],size:[.85,.08,.6],tint:'frame'},
 ...[-1,1].map(x=>({kind:'box',at:[-.19+x*.17,.42,0],size:[.025,.7,.38],tint:'tank'})),
 {kind:'box',at:[-.19,.42,-.18],size:[.34,.7,.025],tint:'tank'},
 ...[0,1,2].map(i=>({kind:'box',at:[-.19,.16+i*.18,0],size:[.3,.16,.32],tint:'cloudy',when:'@cloudy>'+i})),
 {kind:'box',at:[.2,.35,0],size:[.2,.54,.24],tint:'cartridge',when:'@capacity>0'},
 {kind:'box',at:[.2,.35,0],size:[.2,.54,.24],tint:'spent',when:'@capacity<1'},
 {kind:'box',at:[.2,.65,0],size:[.1,.17,.1],tint:'frame'},
 {kind:'box',at:[.2,.75,0],size:[.36,.05,.09],tint:'handle'},
 {kind:'box',at:[.30,.47,.2],size:[.08,.07,.36],tint:'frame'},
 {kind:'box',at:[0,.13,-.21],size:[.16,.18,.12],tint:'cartridge',when:'@spares>0'}
]}},params:{frame:{type:'color',default:'#596266',doc:'pump frame'},tank:{type:'color',default:'#9ba8a4',doc:'reservoir edges'},cloudy:{type:'color',default:'#9b8051',doc:'supplied cloudy water'},cartridge:{type:'color',default:'#e4d8b1',doc:'usable cartridge'},spent:{type:'color',default:'#6a5147',doc:'spent cartridge'},handle:{type:'color',default:'#3d4345',doc:'pump handle'}},palette:{frame:'#596266',tank:'#9ba8a4',cloudy:'#9b8051',cartridge:'#e4d8b1',spent:'#6a5147',handle:'#3d4345'},state:{cloudy:{type:'int',min:0,max:3,default:3},capacity:{type:'int',min:0,max:2,default:2},spares:{type:'int',min:0,max:1,default:1},filtered:{type:'int',min:0,default:0},drained:{type:'int',min:0,default:0},...history} as DefInput['state'],size:{box:[.9,.79,.65]},actions:[['filter-water','Pump one cloudy portion through the cartridge into selected carafe'],['empty-carafe','Drain selected carafe without recovering water or filter life'],['replace-cartridge','Replace spent cartridge using one finite spare']].map(([name,label])=>({name,label,params:{text:{type:'string',max:160,default:'',doc:'Exact nearby filter carafe ID on a fixed table'}},then:[{op:'set',field:'lastReceipt',value:''}]})) as DefInput['actions']};
export const FILTER_CARAFE:DefInput={schema:'def/1',name:'core-filter-carafe',version:1,category:'object.decor',form:'point',description:'An actual portable one-portion filter carafe. Clear water remains integral to this same object through native carrying and placement; deliberate emptying at the camp filter loses the portion. No drinking or potability claim.',tags:['camping','item','water-filter','recorded-item'],make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
 {kind:'box',at:[0,.025,0],size:[.24,.05,.22],tint:'ceramic'},
 ...[-1,1].map(x=>({kind:'box',at:[x*.105,.17,0],size:[.03,.29,.22],tint:'ceramic'})),
 {kind:'box',at:[0,.17,-.095],size:[.18,.29,.03],tint:'ceramic'},
 {kind:'box',at:[0,.17,.095],size:[.025,.29,.02],tint:'glass'},
 {kind:'box',at:[0,.14,0],size:[.18,.2,.17],tint:'clear',when:'@water>0'},
 {kind:'box',at:[.17,.18,0],size:[.04,.18,.04],tint:'ceramic'},
 ...[.1,.26].map(y=>({kind:'box',at:[.135,y,0],size:[.09,.03,.04],tint:'ceramic'}))
]}},params:{ceramic:{type:'color',default:'#e5dcc5',doc:'carafe body and handle'},glass:{type:'color',default:'#a3bcb7',doc:'viewing stripe'},clear:{type:'color',default:'#63adcc',doc:'simulated clear portion'}},palette:{ceramic:'#e5dcc5',glass:'#a3bcb7',clear:'#63adcc'},state:{water:{type:'int',min:0,max:1,default:0},lastBy:{type:'string',max:80,default:''},lastReceipt:{type:'string',max:120,default:''}},components:{carryable:{mass:.7,grips:1}},size:{box:[.38,.33,.24]},actions:[]};
