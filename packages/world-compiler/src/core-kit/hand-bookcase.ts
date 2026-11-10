import type {DefInput} from '../schemas.ts';
import storage from './vocab-w1.json' with {type:'json'};

// The old bookcase's coloured stock is geometry. This revision keeps only the cabinet; every displayed book is an entity.
const original=structuredClone(storage.find(d=>d.name==='core-bookcase')!) as unknown as DefInput;
const make=original.make as {kind:'gen';gen:string;args:{shapes:Record<string,unknown>[]}};
make.args.shapes=make.args.shapes.filter(shape=>shape.tint==='wood'||shape.tint==='back');
const shelfY=.8525; // the authored 0.84 m board is 0.025 m thick
export const HAND_BOOKCASE_DEF:DefInput={
  ...original,version:2,
  description:'An oak bookcase with empty shelves and three places on its waist-height shelf for actual books or small objects (each up to 0.28 m across and 0.30 m tall). Souls put a carried item on the shelf and take a selected item back by hand; nearby you see its real contents. Each item keeps its own identity, appearance and metadata. Other shelves are fixed and empty; no decorative stock is included.',
  tags:[...(original.tags??[]),'hand-operated','storage-inside'],
  synonyms:['bookcase','bookshelf','library shelf','book shelf'],
  params:{wood:{type:'color',default:'#8a5a36',doc:'oak colour'},back:{type:'color',default:'#5e3d27',doc:'back panel colour'},condition:{type:'enum',values:['new','worn','damaged'],default:'new',doc:'Cabinet finish; construction scaffolding is unsupported.'}},
  slots:[...(original.slots??[]).filter(slot=>slot.kind==='stand'),...[-.34,0,.34].map((x,i)=>({id:`in-${i+1}`,kind:'shelf',p:[x,shelfY,.015],yaw:0,accepts:{},capacity:1,label:'book shelf'}))] as DefInput['slots'],
  components:{container:{capacity:3,inside:{lip:shelfY+.02,face:.175,stand:[0,.8],fit:[.28,.3,.28],word:'bookcase'}}} as DefInput['components'],
};
