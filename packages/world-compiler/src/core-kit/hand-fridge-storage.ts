import type {DefInput} from '../schemas.ts';
import {HAND_CABINETS} from './hand-cabinets.ts';

// The existing closed-container path conceals contents. This revision therefore has an opaque insulated door;
// the older glass-front display fridges keep their geometry and decorative bottles unchanged.
const fridge=structuredClone(HAND_CABINETS.find(d=>d.name==='core-drinks-fridge')!) as DefInput;
const make=fridge.make as {kind:'gen';gen:string;args:{shapes:Record<string,unknown>[]}};
make.args.shapes=make.args.shapes.filter(s=>!(s.kind==='cyl'&&/^g[0-3]$/.test(String(s.tint))));
for(const shape of make.args.shapes)if(shape.role==='door'&&shape.tint==='glass'){
  shape.tint='body';delete shape.material;
}

export const FRIDGE_STORAGE_DEF:DefInput={
  ...fridge,version:3,
  params:{...fridge.params,condition:{type:'enum',values:['new','worn','damaged'],default:'new',doc:'Appliance finish: new, worn or damaged. Construction scaffolding is unsupported.'}},
  description:'An insulated drinks fridge with an opaque door operated by hand. One waist-height shelf holds one real carried item (up to 0.26 m across and 0.32 m tall). Open the fridge to put something inside or take it out; closing the door conceals the same stored item. The other shelves are fixed and empty.',
  tags:[...(fridge.tags??[]),'storage-inside'],
  synonyms:[...(fridge.synonyms??[]),'insulated fridge','insulated drinks fridge'],
  slots:[...(fridge.slots??[]),{id:'in-1',kind:'shelf',p:[0,1.13,.14],yaw:0,accepts:{},capacity:1,label:'fridge shelf'}] as DefInput['slots'],
  components:{...fridge.components,container:{capacity:1,inside:{lip:1.145,face:.345,stand:[.16,.95],fit:[.26,.32,.26],word:'fridge'}}} as DefInput['components'],
};
