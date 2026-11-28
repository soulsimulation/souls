import test from 'node:test';import assert from 'node:assert/strict';
import {Group,Mesh,PlaneGeometry,MeshBasicMaterial,Vector3,Matrix4,PerspectiveCamera,BoxGeometry} from 'three';
import {DisplayedCameraObserver} from './observation.ts';
import {FollowGeometry,FOLLOW_LIMITS} from './follow-camera.ts';import {InteriorView} from './interior.ts';import type {EnclosureResult} from './enclosure.ts';
const v=(x=0,y=0,z=0)=>new Vector3(x,y,z);
const room={id:'room',floor:0,y:0,height:4,poly:[[-4,-4],[4,-4],[4,4],[-4,4]]};
const context=()=>({status:'enclosed',building:'b',room:'room',floor:0,revision:'r',sourceRevision:'s',worldMatrix:new Matrix4().toArray(),region:room,proposals:[[0,1.6,0]]} as unknown as EnclosureResult);
function fixture(){const root=new Group(),inner=new Group(),wall=new Mesh(new PlaneGeometry(20,20),new MeshBasicMaterial());inner.userData.cameraEnclosure={schema:'building-camera/1'};root.add(inner);inner.add(wall);wall.rotation.y=Math.PI/2;root.updateMatrixWorld(true);const q=new FollowGeometry();q.prepare([root],'r');return{root,inner,wall,q};}
test('authored building query retains hidden walls and full triangles across draw-cut block preparation',()=>{const{root,inner,wall,q}=fixture();wall.geometry.setDrawRange(0,0);wall.visible=false;(wall.material as MeshBasicMaterial).visible=false;inner.visible=false;
 for(let i=0;i<4;i++){q.prepare([root],'r');assert.equal(q.segment(v(-2),v(2)),'clear');assert.equal(q.segmentAuthored(v(-2),v(2)),'blocked');assert.equal(q.segmentAuthored(v(-2),v(2),.1),'blocked');}
 assert.equal(wall.geometry.drawRange.count,0);assert.equal(wall.visible,false);assert.equal(inner.visible,false);
 wall.geometry.setDrawRange(0,Infinity);wall.visible=true;inner.visible=true;(wall.material as MeshBasicMaterial).visible=true;q.prepare([root],'r');assert.equal(q.segment(v(-2),v(2)),'blocked');
});
test('full-authored query does not resurrect unrelated invisible rendered obstacles',()=>{const root=new Group(),m=new Mesh(new PlaneGeometry(20,20),new MeshBasicMaterial());m.rotation.y=Math.PI/2;m.visible=false;root.add(m);root.updateMatrixWorld(true);const q=new FollowGeometry();q.prepare([root],'r');assert.equal(q.segmentAuthored(v(-2),v(2)),'clear');});
test('readable exterior eye persists in world space and manual/context changes clear it',()=>{const p=new InteriorView(),q=new FollowGeometry(),root=new Group();root.updateMatrixWorld(true);q.prepare([root],'r');const c=context(),eye=v(7,2,0),points=[v(0,1,0),v(0,1.6,0)];p.sync(c,false,q.generation);p.search(0,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'holding');assert.deepEqual(p.sync(c,false,q.generation)?.toArray(),eye.toArray());assert.equal(p.sync(c,true,q.generation),null);assert.equal(p.sync(c,false,q.generation),null);p.search(1,eye,points,q,()=>.2,()=>0);assert.equal(p.sync({...c,sourceRevision:'changed'},false,q.generation),null);});
test('a readable room destination across an opaque wall remains unreachable without a cut',()=>{const{q}=fixture(),p=new InteriorView(),c=context(),eye=v(6,2,0),points=[v(-1,1,0),v(-1,1.6,0)];p.sync(c,false,q.generation);p.search(0,eye,points,q,()=>.2,()=>0);p.search(.3,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'readable-proposal-unreachable');assert.equal(p.diagnostic.visibility,'clear');assert.equal(p.diagnostic.passage,'blocked');assert.equal(p.sync(c,false,q.generation),null);assert.equal(p.diagnostic.containment,'unproved');});
test('unknown destination or passage cannot become a persistent anchor',()=>{for(const failing of['destination','passage']){const p=new InteriorView(),c=context(),q=new FollowGeometry();let calls=0;q.segmentAuthored=(_a,_b,r=0)=>{calls++;if(calls===1)return'blocked';if(failing==='destination'&&r>0)return'unknown';if(failing==='passage'&&calls===5)return'unknown';return'clear';};p.sync(c,false,0);p.search(0,v(6,2,0),[v(-1,1,0),v(-1,1.6,0)],q,()=>.2,()=>0);p.search(.3,v(6,2,0),[v(-1,1,0),v(-1,1.6,0)],q,()=>.2,()=>0);assert.equal(p.diagnostic.status,failing==='destination'?'proposal-unknown':'passage-unknown');assert.equal(p.sync(c,false,0),null);}});

test('authored glass admits a visibility ray but blocks a camera envelope',()=>{const{wall,q,root}=fixture();(wall.material as MeshBasicMaterial).transparent=true;(wall.material as MeshBasicMaterial).opacity=.38;q.prepare([root],'r');assert.equal(q.segmentAuthored(v(-2),v(2)),'clear');assert.equal(q.segmentAuthored(v(-2),v(2),0,true),'blocked');assert.equal(q.segmentAuthored(v(-2),v(2),.1),'blocked');assert.equal(q.segmentAuthored(v(.05),v(.05),.1),'blocked');});
test('occluded transit retains the separately validated persistent destination',()=>{const p=new InteriorView(),c=context(),q=new FollowGeometry(),eye=v(6,2,0),points=[v(-1,1,0),v(-1,1.6,0)];q.segmentAuthored=(from,_to,r=0)=>r>0||from.x<0?'clear':'blocked';p.sync(c,false,0);p.search(0,eye,points,q,()=>.2,()=>0);p.search(.3,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'selected');const anchor=p.sync(c,false,0)!.toArray();p.search(1,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'holding');assert.deepEqual(p.sync(c,false,0)?.toArray(),anchor);});
test('opening-adjacent exterior proposals are attempted before room anchors and still require full validation',()=>{const p=new InteriorView(),c={...context(),openingProposals:[{kind:'door' as const,floor:0,at:[0,-4] as const,width:1,height:2,sill:0,from:'room',to:null}]},q=new FollowGeometry();let proposed:Vector3|null=null;q.segmentAuthored=(from,_to,r=0)=>{if(r>0){proposed=from.clone();return'unknown';}return'blocked';};p.sync(c,false,0);p.search(0,v(6,2,0),[v(0,1,0),v(0,1.6,0)],q,()=>.2,()=>0);p.search(.3,v(6,2,0),[v(0,1,0),v(0,1.6,0)],q,()=>.2,()=>0);assert.deepEqual((proposed as Vector3|null)?.toArray(),[0,1.6,-5.2]);assert.equal(p.diagnostic.status,'proposal-unknown');assert.equal(p.sync(c,false,0),null);});

test('blocked retained sight skips redundant envelope work so the preferred door fits the real shared budget',()=>{const root=new Group(),wall=new Mesh(new PlaneGeometry(1,4),new MeshBasicMaterial()),g=new PlaneGeometry(128,128,128,128);g.rotateX(-Math.PI/2);g.attributes.position.setY(0,20);g.attributes.position.needsUpdate=true;root.add(new Mesh(g,new MeshBasicMaterial()),wall);wall.rotation.y=Math.PI/2;wall.position.set(100,2,0);root.updateMatrixWorld(true);const q=new FollowGeometry(),p=new InteriorView(),c={...context(),openingProposals:[{kind:'door' as const,floor:0,at:[0,4] as const,width:1.6,height:2.1,sill:0,from:'room',to:'outside'}]},eye=v(6,2,0),points=[v(0,1,0),v(0,1.6,0)];for(let i=0;i<100;i++){q.prepare([root],'r');q.segmentAuthored(eye,points[0]);}p.sync(c,false,q.generation);p.search(0,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'holding');wall.position.x=3;root.updateMatrixWorld(true);for(let i=0;i<20;i++){q.prepare([root],'r');q.segmentAuthored(eye,points[0]);}q.prepare([root],'r');q.segmentAuthored(eye,eye,.2);p.sync(c,false,q.generation);p.search(1,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'anchor-invalidated');q.prepare([root],'r');assert.equal(q.segmentAuthored(eye,eye,.2),'clear');p.search(1.3,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'selected');assert.deepEqual(p.diagnostic.anchor,[0,1.6,5.2]);assert.ok(q.stats.blockVisits>=2500&&q.stats.blockVisits<=FOLLOW_LIMITS.blockVisits);assert.equal(q.stats.unknown,null);});
test('unknown candidate gets one fresh retry before advancing and returning to current-eye phase',()=>{
 const p=new InteriorView(),c={...context(),openingProposals:[{kind:'door' as const,floor:0,at:[0,4] as const,width:1.6,height:2.1,sill:0,from:'room',to:'outside'}]},q=new FollowGeometry(),eye=v(6,2,0),points=[v(0,1,0),v(0,1.6,0)];let current=0,candidate=0;
 q.segmentAuthored=(from,_to,r=0)=>{if(from.equals(eye)){current++;return'unknown';}candidate++;return r>0?'unknown':'clear';};p.sync(c,false,0);
 p.search(0,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'visibility-unknown');assert.equal(candidate,0);
 p.sync(c,false,0);p.search(.3,eye,points,q,()=>.2,()=>0);const first=p.diagnostic.proposal;assert.equal(candidate,1);assert.equal(current,1);
 p.sync(c,false,0);p.search(.6,eye,points,q,()=>.2,()=>0);assert.deepEqual(p.diagnostic.proposal,first);assert.equal(candidate,2);
 p.sync(c,false,0);p.search(.9,eye,points,q,()=>.2,()=>0);assert.equal(current,2);assert.equal(candidate,2);
 p.sync(c,false,0);p.search(1.2,eye,points,q,()=>.2,()=>0);assert.notDeepEqual(p.diagnostic.proposal,first);assert.equal(p.destination(),null);
});
test('clear current eye cannot bypass the minimum distance of an invalidated anchor',()=>{const p=new InteriorView(),c=context(),q=new FollowGeometry(),eye=v(6,2,0);q.segmentAuthored=()=> 'clear';p.sync(c,false,0);p.search(0,eye,[v(0,1,0),v(0,1.6,0)],q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'holding');q.segmentAuthored=(from)=>from.equals(eye)?'clear':'unknown';p.sync(c,false,0);p.search(.3,eye,[v(5.8,1.5,0),v(5.8,1.8,0)],q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'anchor-invalidated');p.search(.6,eye,[v(5.8,1.5,0),v(5.8,1.8,0)],q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'proposal-unknown');assert.equal(p.sync(c,false,0),null);});
test('a retried proposal rechecks envelope, both sight anchors and passage before selection',()=>{const p=new InteriorView(),c=context(),q=new FollowGeometry(),eye=v(6,2,0),points=[v(0,1,0),v(0,1.6,0)];q.segmentAuthored=(_from,_to,r=0)=>r>0?'unknown':'blocked';p.sync(c,false,0);p.search(0,eye,points,q,()=>.2,()=>0);p.search(.3,eye,points,q,()=>.2,()=>0);const first=p.diagnostic.proposal;let calls=0;q.segmentAuthored=(from,_to,r=0)=>{calls++;return r>0||!from.equals(eye)?'clear':'blocked';};p.sync(c,false,0);p.search(.6,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'selected');assert.deepEqual(p.diagnostic.proposal,first);assert.equal(calls,4);});

function retreatFixture(){
 const root=new Group(),q=new FollowGeometry(),p=new InteriorView(),c=context(),eye=v(0,1.7,7),camera=new PerspectiveCamera(45,390/844,.1,100);root.updateMatrixWorld(true);q.prepare([root],'r');camera.position.copy(eye);camera.lookAt(v(0,1,0));camera.updateMatrixWorld(true);p.sync(c,false,q.generation);p.search(0,eye,[v(0,1,0),v(0,1.6,0)],q,()=>.2,()=>0);
 const mesh=new Mesh(new BoxGeometry(.6,2,.4),new MeshBasicMaterial());mesh.position.set(0,1,0);mesh.updateMatrixWorld(true);const observation=new DisplayedCameraObserver().capture({version:{world:'w',epoch:'e',revision:'r'},tick:1,seconds:1,subjects:[{id:'a',root:mesh}]});if(observation.status!=='observed'||observation.value.subjects[0].state!=='present')throw Error('fixture');const base=observation.value.subjects[0];
 const subject=(z=0,speed=1.2)=>({...base,transform:{...base.transform,positionM:[0,1,z] as [number,number,number]},travelMps:{value:[0,0,speed] as [number,number,number],confidence:1,source:'derived' as const}});
 return{p,q,c,eye,camera,subject,check:{geometry:q,points:[v(0,1,1),v(0,1.6,1)],radius:()=>.2,ground:()=>0},viewport:{width:390,height:844,insets:{top:100,bottom:180}},projection:{width:390,height:844,fov:45}};
}
test('retreat uses usable portrait extent, refuses unavailable framing, and clears on context/manual changes',()=>{
 for(const mode of ['missing-projection','infeasible','unknown-travel','valid']){const f=retreatFixture(),body=f.subject(1);if(mode==='unknown-travel')body.travelMps.confidence=NaN;f.p.prepareRetreat(1,body,f.camera,f.eye,mode==='infeasible'?{width:390,height:844,insets:{right:389}}:f.viewport,mode==='missing-projection'?undefined:f.projection,f.check);if(mode==='valid')assert.ok(f.p.destination()!.eye.z>7);else assert.equal(f.p.destination()!.eye.z,7,mode);}
 const f=retreatFixture();f.p.prepareRetreat(1,f.subject(1),f.camera,f.eye,f.viewport,f.projection,f.check);assert.equal(f.p.diagnostic.retreat,'advancing');const anchor=f.p.destination()!.eye.toArray();f.p.prepareRetreat(1.3,f.subject(1,0),f.camera,f.eye,f.viewport,f.projection,f.check);assert.deepEqual(f.p.destination()!.eye.toArray(),anchor);f.p.prepareRetreat(1.6,f.subject(.8,-1.2),f.camera,f.eye,f.viewport,f.projection,f.check);assert.deepEqual(f.p.destination()!.eye.toArray(),anchor);assert.equal(f.p.sync(f.c,false,f.q.generation+1),null);assert.equal(f.p.diagnostic.retreat,'inactive');f.p.sync(f.c,true,f.q.generation);assert.equal(f.p.destination(),null);
});

test('invalid or discontinuous travel discards retreat preparation and refused destinations never replace the anchor',()=>{
 for(const invalid of['unknown','vertical-spike']){const f=retreatFixture();f.p.prepareRetreat(1,f.subject(1),f.camera,f.eye,f.viewport,f.projection,f.check);const validAnchor=f.p.destination()!.eye.clone(),bad=f.subject(1.2);if(invalid==='unknown')bad.travelMps.confidence=NaN;else bad.travelMps.value=[0,5,1];f.p.prepareRetreat(1.05,bad,f.camera,validAnchor,f.viewport,f.projection,f.check);assert.deepEqual(f.p.destination()!.eye.toArray(),validAnchor.toArray());f.p.prepareRetreat(1.3,f.subject(-10),f.camera,validAnchor,f.viewport,f.projection,f.check);assert.deepEqual(f.p.destination()!.eye.toArray(),validAnchor.toArray(),'distant valid root must require a fresh framing cue rather than old progress');}
 for(const refusal of['blocked','unknown'] as const){const f=retreatFixture();f.q.segmentAuthored=()=>refusal;f.p.prepareRetreat(1,f.subject(1),f.camera,f.eye,f.viewport,f.projection,f.check);assert.deepEqual(f.p.destination()!.eye.toArray(),f.eye.toArray());assert.equal(f.p.diagnostic.retreat,'target-'+refusal);}
});

test('approaching opening admits only a full-framed checked continuous target and retains it across membership',()=>{
 const refusals={frame:'approach-framing-unavailable',radius:'proposal-unavailable',ground:'proposal-unavailable',envelope:'proposal-surface-overlap','envelope-unknown':'proposal-unknown',sight:'proposal-occluded','sight-unknown':'proposal-unknown',passage:'readable-proposal-unreachable','passage-unknown':'passage-unknown',none:'selected'};
 for(const [refusal,status]of Object.entries(refusals)){
  const p=new InteriorView(),c={...context(),status:'approaching',openingProposals:[{kind:'door' as const,floor:0,at:[0,-4] as const,width:1.5,height:2,sill:0,from:'room',to:null}]},q=new FollowGeometry(),eye=v(6,3,-8),points=[v(-3,1,-5),v(-3,1.6,-5)];
  q.segmentAuthored=(from,to,r=0)=>{const check=r===0?'sight':from.equals(to)?'envelope':'passage';return refusal===check?'blocked':refusal===check+'-unknown'?'unknown':'clear';};
  p.sync(c,false,0);p.search(0,eye,points,q,()=>refusal==='radius'?null:.2,()=>refusal==='ground'?null:0,()=>refusal!=='frame');assert.equal(p.diagnostic.status,status,refusal);
  if(refusal==='none'){assert.deepEqual(p.destination()?.eye.toArray(),[0,1.6,-8]);const anchor=p.destination()!.eye.toArray();q.segmentAuthored=()=> 'unknown';p.sync(c,false,0);p.search(.3,eye,points,q,()=>.2,()=>0,()=>true);assert.equal(p.diagnostic.status,'anchor-unknown');assert.deepEqual(p.destination()?.eye.toArray(),anchor,'retained approaching anchor still validates sight before reuse');assert.deepEqual(p.sync({...c,status:'enclosed'},false,0)?.toArray(),anchor);p.sync(c,true,0);assert.equal(p.destination(),null);}
  else assert.equal(p.destination(),null,refusal);
 }
});
test('opening switches invalidate intent and membership restores ordinary recovery proposals without losing a validated anchor',()=>{for(const selected of[false,true]){const p=new InteriorView(),c={...context(),status:'approaching',openingProposals:[{kind:'door' as const,floor:0,at:[0,-4] as const,width:1.5,height:2,sill:0,from:'room',to:null}]},q=new FollowGeometry(),eye=v(6,3,0),points=[v(0,1,0),v(0,1.6,0)];q.segmentAuthored=(from,_to,r=0)=>r>0||!from.equals(eye)?'clear':'blocked';p.sync(c,false,0);p.search(0,eye,points,q,()=>.2,()=>0,()=>selected);const anchor=p.destination()?.eye.toArray();p.sync({...c,status:'enclosed'},false,0);assert.deepEqual(p.destination()?.eye.toArray(),anchor);q.segmentAuthored=(from,_to,r=0)=>r>0||!from.equals(eye)&&from.z!==-8?'clear':'blocked';p.search(1,eye,points,q,()=>.2,()=>0);p.search(1.3,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'selected');assert.deepEqual(p.destination()?.eye.toArray(),[0,1.6,-5.2]);p.sync(c,false,0);p.sync({...c,openingProposals:[{...c.openingProposals[0],at:[2,-4]}]},false,0);assert.equal(p.destination(),null);}});


test('unanchored approach completes candidate admission in the real shared terrain budget and refuses exhaustion',()=>{
 const root=new Group(),terrain=new PlaneGeometry(128,128,256,128);terrain.rotateX(-Math.PI/2);terrain.attributes.position.setY(0,20);terrain.attributes.position.needsUpdate=true;root.add(new Mesh(terrain,new MeshBasicMaterial()));root.updateMatrixWorld(true);
 const q=new FollowGeometry(),eye=v(70,3,-8),points=[v(-3,1,-5),v(-3,1.6,-5)],proposal=v(0,1.6,-8),c={...context(),status:'approaching',openingProposals:[{kind:'door' as const,floor:0,at:[0,-4] as const,width:1.5,height:2,sill:0,from:'room',to:null}]};
 // Prewarm the real 65,536-triangle terrain. Every overlapping query must visit
 // its 1,024 retained blocks; the distant raised vertex keeps bounds relevant.
 for(let i=0;i<160;i++){q.prepare([root],'r');q.segmentAuthored(proposal,points[0]);}
 assert.equal(q.stats.retainedBlocks,1024);
 for(const exhausted of[false,true]){
  const p=new InteriorView();q.prepare([root],'r');assert.equal(q.stats.complete,true);
  assert.equal(q.segmentAuthored(eye,eye.clone().add(v(.01,0,0)),.2),'clear','mandatory actual movement is checked first');assert.equal(q.stats.blockVisits,0);
  if(exhausted)assert.equal(q.segmentAuthored(proposal,points[0],0,true),'clear');
  p.sync(c,false,q.generation);p.search(0,eye,points,q,()=>.2,()=>0,()=>true);
  assert.equal(q.stats.blockVisits,FOLLOW_LIMITS.blockVisits);
  if(exhausted){assert.equal(p.diagnostic.status,'passage-unknown');assert.equal(q.stats.unknown,'block-query-cap');assert.equal(p.destination(),null);}
  else{assert.equal(p.diagnostic.status,'selected');assert.equal(p.diagnostic.visibility,'clear');assert.equal(p.diagnostic.passage,'clear');assert.deepEqual(p.destination()?.eye.toArray(),proposal.toArray());assert.equal(q.stats.unknown,null);assert.equal(q.stats.queries,5,'actual sweep, envelope, two candidate sight anchors and full passage');}
 }
});


test('enclosed fresh candidate slot completes real shared-budget admission after current-eye refusal',()=>{
 const root=new Group(),terrain=new PlaneGeometry(128,128,256,128);terrain.rotateX(-Math.PI/2);terrain.attributes.position.setY(0,20);terrain.attributes.position.needsUpdate=true;const wall=new Mesh(new PlaneGeometry(1,4),new MeshBasicMaterial());wall.rotation.y=Math.PI/2;wall.position.set(40,2,-6.7);root.add(new Mesh(terrain,new MeshBasicMaterial()),wall);root.updateMatrixWorld(true);
 const q=new FollowGeometry(),eye=v(70,3,-8),points=[v(-3,1,-5),v(-3,1.6,-5)],proposal=v(0,1.6,5.2),c={...context(),openingProposals:[{kind:'door' as const,floor:0,at:[0,4] as const,width:1.5,height:2,sill:0,from:'room',to:null}]};
 for(let i=0;i<160;i++){q.prepare([root],'r');q.segmentAuthored(proposal,points[0]);}
 assert.equal(q.stats.retainedBlocks,1024);
 for(const exhausted of[false,true]){
  const p=new InteriorView();q.prepare([root],'r');assert.equal(q.segmentAuthored(eye,eye.clone().add(v(.01,0,0)),.2),'clear');p.sync(c,false,q.generation);p.search(0,eye,points,q,()=>.2,()=>0);assert.equal(p.destination(),null);
  q.prepare([root],'r');assert.equal(q.segmentAuthored(eye,eye.clone().add(v(.01,0,0)),.2),'clear');if(exhausted)assert.equal(q.segmentAuthored(proposal,points[0],0,true),'clear');p.sync(c,false,q.generation);p.search(.3,eye,points,q,()=>.2,()=>0);
  assert.equal(q.stats.blockVisits,FOLLOW_LIMITS.blockVisits);
  if(exhausted){assert.equal(p.diagnostic.status,'passage-unknown');assert.equal(q.stats.unknown,'block-query-cap');assert.equal(p.destination(),null);}
  else{assert.equal(p.diagnostic.status,'selected');assert.deepEqual(p.destination()?.eye.toArray(),proposal.toArray());assert.equal(p.diagnostic.visibility,'clear');assert.equal(p.diagnostic.passage,'clear');assert.equal(q.stats.unknown,null);assert.equal(q.stats.queries,5);}
 }
});

test('manual, context and membership changes clear the candidate phase without carrying query answers',()=>{
 for(const reset of['manual','context','membership']){
  const p=new InteriorView(),q=new FollowGeometry(),c=context(),eye=v(6,2,0),points=[v(0,1,0),v(0,1.6,0)];let calls=0;q.segmentAuthored=()=>{calls++;return'blocked';};p.sync(c,false,0);p.search(0,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'candidate-pending');assert.equal(calls,1);
  if(reset==='manual')p.sync(c,true,0);else if(reset==='context')p.sync({...c,sourceRevision:'changed'},false,0);else p.sync({...c,status:'approaching'},false,0);
  p.sync(c,false,0);p.search(.3,eye,points,q,()=>.2,()=>0);assert.equal(p.diagnostic.status,'candidate-pending',reset);assert.equal(calls,2,reset);
 }
});


test('approaching invalidated anchor retains same-slot fresh candidate admission',()=>{
 const p=new InteriorView(),q=new FollowGeometry(),c={...context(),status:'approaching',openingProposals:[{kind:'door' as const,floor:0,at:[0,-4] as const,width:1.5,height:2,sill:0,from:'room',to:null}]},eye=v(6,3,-8),points=[v(-3,1,-5),v(-3,1.6,-5)];q.segmentAuthored=()=> 'clear';p.sync(c,false,0);p.search(0,eye,points,q,()=>.2,()=>0,()=>true);assert.deepEqual(p.destination()?.eye.toArray(),[0,1.6,-8]);
 q.segmentAuthored=(from,_to,r=0)=>r===0&&from.z===-8?'blocked':'clear';p.sync(c,false,0);p.search(.3,eye,points,q,()=>.2,()=>0,()=>true);assert.equal(p.diagnostic.status,'selected');assert.deepEqual(p.destination()?.eye.toArray(),[0,1.6,0]);
});
