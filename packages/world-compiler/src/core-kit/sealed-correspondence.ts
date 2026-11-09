// A portable message with one-way visible seal integrity; existing gestures commit on admission.
import type {DefInput} from '../schemas.ts';
export const SEALED_CORRESPONDENCE:DefInput={
 schema:'def/1',name:'core-sealed-correspondence',version:1,form:'point',
 description:'A carryable correspondence envelope: write one message, seal the red wax, then break/open it once. The message remains readable, and the split wax permanently shows opened integrity. Short native craft actions commit on admission, not hand contact/completion. Not confidential or cryptographically authenticated; set down before operating.',
 tags:['item','recorded-item','correspondence'],synonyms:['letter','envelope','sealed message','correspondence'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
  {kind:'box',at:[0,.12,0],size:[.34,.24,.018],tint:'paper'},
  {kind:'box',at:[0,.185,.014],size:[.28,.045,.012],tint:'fold',when:'@stage!=opened'},
  {kind:'box',at:[0,.253,-.012],size:[.28,.065,.012],tint:'fold',when:'@stage=opened'},
  {kind:'sphere',at:[0,.185,.032],r:.03,segments:8,scale:[1,1,.3],tint:'wax',when:'@stage=sealed'},
  {kind:'sphere',at:[-.045,.19,.032],r:.018,segments:6,scale:[1,1,.35],tint:'wax',when:'@stage=opened'},
  {kind:'sphere',at:[.04,.24,.004],r:.018,segments:6,scale:[1,1,.35],tint:'wax',when:'@stage=opened'}
,{kind:'box',at:[0,.11,.011],size:[.24,.006,.003],tint:'ink',when:'@stage!=blank'},{kind:'box',at:[-.03,.08,.011],size:[.18,.006,.003],tint:'ink',when:'@stage!=blank'}]}} as DefInput['make'],
 params:{},palette:{paper:'#eee4c7',fold:'#d8cbaa',wax:'#a52d37',ink:'#34302d'},size:{box:[.34,.286,.06]},
 state:{text:{type:'string',max:240,default:''},stage:{type:'enum',values:['blank','written','sealed','opened'],default:'blank'}},
 components:{carryable:{mass:.03,grips:1}} as DefInput['components'],slots:[],
 actions:[
  {name:'write',label:'Compose the blank correspondence (one message)',params:{text:{type:'string',max:240,doc:'Message, up to240characters; written once before sealing. Readable even when sealed; no secrecy.'}},when:[{field:'stage',is:'blank'}],then:[{op:'set',field:'text',value:{param:'text'}},{op:'set',field:'stage',value:'written'}]},
  {name:'seal',label:'Seal the written correspondence with intact red wax',params:{},when:[{field:'stage',is:'written'}],then:[{op:'set',field:'stage',value:'sealed'}]},
  {name:'open-seal',label:'Break/open the intact seal permanently',params:{},when:[{field:'stage',is:'sealed'}],then:[{op:'set',field:'stage',value:'opened'}]},
 ] as DefInput['actions'],
};
