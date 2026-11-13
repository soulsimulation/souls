// One packed ration becomes accessible after completed opening; packaging is permanent.
import type {DefInput} from '../schemas.ts';
export const SEALED_RATION:DefInput={schema:'def/1',name:'core-sealed-ration-tin',version:1,category:'object.decor',form:'point',
 description:'A sealed pull-tab camping ration tin with two bites of ready-to-eat beans. Place on a fixed work surface and open with four seconds native hand work. Native eating cannot consume sealed contents. Pick up and eat once open; the empty tin and its attached folded-back lid remain real and portable.',
 tags:['camping','kitchen','item','food','edible','recorded-item'],synonyms:['ration tin','sealed ration','camp food'],
 make:{kind:'gen',gen:'kit/2',args:{round:0,shapes:[
 {kind:'lathe',at:[0,0,0],profile:[[0,0],[.08,0],[.08,.14],[.073,.14],[.073,.01],[0,.01]],segments:8,tint:'metal'},
 {kind:'cyl',at:[0,.142,0],r:.077,h:.006,segments:8,tint:'lid',when:'!@open'},
 {kind:'box',at:[0,.149,.015],size:[.035,.006,.015],round:0,tint:'tab',when:'!@open'},
 {kind:'cyl',at:[0,.075,-.089],r:.075,h:.006,segments:8,pitch:1.5707963267948966,tint:'lid',when:'@open'},
 {kind:'box',at:[0,.145,-.079],size:[.025,.012,.025],round:0,tint:'metal'},
 {kind:'box',at:[0,.075,-.095],size:[.035,.015,.006],round:0,tint:'tab',when:'@open'},
 {kind:'cyl',at:[0,.104,0],r:.071,h:.047,segments:8,tint:'beans',when:'@packed'},
 {kind:'cyl',at:[0,.104,0],r:.071,h:.047,segments:8,tint:'beans',when:'@open&@left>0.6'},
 {kind:'cyl',at:[0,.044,0],r:.071,h:.045,segments:8,tint:'beans',when:'@open&@left>0.05&@left<=0.6'}]}},
 params:{metal:{type:'color',default:'#9b9b91',doc:'tin metal'},lid:{type:'color',default:'#c6c8ba',doc:'retained lid'},tab:{type:'color',default:'#62685d',doc:'pull tab'},beans:{type:'color',default:'#b77436',doc:'supplied beans'}},palette:{metal:'#9b9b91',lid:'#c6c8ba',tab:'#62685d',beans:'#b77436'},
 state:{open:{type:'bool',default:false},packed:{type:'bool',default:true},left:{type:'number',min:0,max:1,default:0},bites:{type:'number',min:1,max:8,default:2},openedBy:{type:'string',max:80,default:''},lastReceipt:{type:'string',max:120,default:''},lastCompletedTick:{type:'number',default:-1}},
 components:{carryable:{mass:.35,grips:1}},size:{box:[.17,.16,.19]},
 actions:[{name:'open-ration',label:'Open sealed pull-tab ration (4 seconds hand work)',when:[{field:'open',is:false}],then:[{op:'set',field:'lastReceipt',value:''}]},{name:'bite',label:'Take one bite of opened ration',when:[{field:'open',is:true}],then:[{op:'set',field:'left',value:0}]},{name:'eat',label:'Eat remaining opened ration',when:[{field:'open',is:true}],then:[{op:'set',field:'left',value:0}]}],
};
