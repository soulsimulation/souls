import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldModel,coreLibrary,coreRef,applyBatch,type Entity,type StoredDef} from '@souls/world-compiler';
import {assetIdFor} from '../../../packages/engine-mars/src/catalog-adapter.ts';
import {prepareIncenseContact,placeIncenseContact} from './incense-contact-context.ts';

function fixture(){
  const model=new WorldModel({constants:{ground:'land',extent:100},seed:'incense-contact'});model.library=coreLibrary();
  const placed=applyBatch(model,{ops:[{op:'place',def:coreRef('incense-censer',1),name:'censer',p:[1.5,3],r:.6}]},'god',1);
  assert.equal(placed.result.accepted,true);
  const entity=model.get('censer')!,def=model.resolvedDef(entity.def)!,pose=model.worldPose(entity),baked=model.bake(def,entity.params??{},entity.seed??0,entity.shape);
  return {model,entity,def,pose,baked};
}
test('authored incense context matches existing native seen identity and native valve transform',()=>{
  const {entity,def,pose,baked}=fixture(),prepared=prepareIncenseContact(def,entity,baked.box,pose.s);assert.ok(prepared);
  const expected=assetIdFor({ref:def.ref,hash:def.hash,components:def.components,
    slots:baked.slots,box:baked.box.map(v=>v*pose.s) as [number,number,number]},JSON.stringify(entity.params??{})+'|seen');
  assert.equal(prepared.nativeDef,expected);
  const context=placeIncenseContact(prepared,entity.id,pose)!;
  const args=def.make.kind==='gen'?def.make.args as {shapes:{tint:string;at:number[];r?:number}[]}:null;
  const tip=args!.shapes.find(s=>s.tint==='valve')!,[x,y,z]=tip.at.map(v=>v*pose.s),c=Math.cos(pose.yaw),s=Math.sin(pose.yaw);
  assert.deepEqual(context.tip,[pose.x+x*c+z*s,pose.y+y,pose.z-x*s+z*c]);
  assert.equal(context.tipRadius,tip.r!*pose.s);assert.equal(context.bowlTop,pose.y+(.86+.06)*pose.s);
  assert.equal(context.radius,.13*pose.s);assert.equal(context.revision,def.hash);
  assert.deepEqual(prepareIncenseContact(def,{...entity,state:{on:true}} as Entity,baked.box,pose.s),prepared,'on/off state does not change the qualified solid recipe');
  assert.ok(prepareIncenseContact(def,{...entity,params:{}},baked.box,pose.s),'declared default params need no entity override');
});
test('unsupported authored recipes, transforms and malformed values do not supply a contact context',()=>{
  const {entity,def,pose,baked}=fixture();
  const variants:[StoredDef,Entity,readonly number[],number][]=[
    [{...def,tags:def.tags.filter(t=>t!=='incense')},entity,baked.box,pose.s],
    [{...def,tags:[...def.tags,'fire']},entity,baked.box,pose.s],
    [{...def,make:{...def.make,args:{shapes:[]}} as StoredDef['make']},entity,baked.box,pose.s],
    [def,{...entity,r:[.6,.1,0]},baked.box,pose.s],
    [def,{...entity,params:{...entity.params,sx:2}},baked.box,pose.s],
    [def,{...entity,params:{...entity.params,smokeScale:NaN}},baked.box,pose.s],
    [def,entity,[.26,Infinity,.26],pose.s],[def,entity,baked.box,0],
  ];
  for(const args of variants)assert.equal(prepareIncenseContact(...args),null);
  const prepared=prepareIncenseContact(def,entity,baked.box,pose.s)!;
  assert.equal(placeIncenseContact(prepared,entity.id,{...pose,yaw:NaN}),null);
  assert.equal(placeIncenseContact(prepared,entity.id,{...pose,s:Number.MAX_VALUE}),null);
});
