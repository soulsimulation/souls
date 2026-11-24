import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {WorldSoulAvatars,soulAvatars,wantPortrait} from '../src/SoulAvatars.ts';

test('portrait capture restores shared renderer state on success and render failure, before its pixels come back',async()=>{
 const previousDocument=globalThis.document;
 let image:Uint8ClampedArray|null=null;
 globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:(v:{data:Uint8ClampedArray})=>{image=v.data;}}),toDataURL:()=> 'data:image/png;base64,private-test'})} as unknown as Document;
 const originalTarget=new THREE.WebGLRenderTarget(30,40),viewport=new THREE.Vector4(2,3,20,25),scissor=new THREE.Vector4(1,2,15,20);
 let slowMs=0,current:THREE.WebGLRenderTarget|null=originalTarget,actualViewport=viewport.clone(),actualScissor=scissor.clone(),scissorTest=true,throwRender=false,disposed=false;
 const renderer={autoClear:false,getRenderTarget:()=>current,getViewport:(out:THREE.Vector4)=>out.copy(actualViewport),getScissor:(out:THREE.Vector4)=>out.copy(actualScissor),getScissorTest:()=>scissorTest,
  setRenderTarget:(v:THREE.WebGLRenderTarget|null)=>{current=v;},setViewport:(v:THREE.Vector4)=>{actualViewport.copy(v);},setScissor:(v:THREE.Vector4)=>{actualScissor.copy(v);},setScissorTest:(v:boolean)=>{scissorTest=v;},
  render:(scene:THREE.Scene)=>{assert.equal(current?.width,96);assert.equal(current?.height,96);assert.equal(scene.getObjectByName('activity prop: test-book'),undefined,'neutral portrait excludes carried props');if(throwRender)throw Error('GPU failure');const until=performance.now()+slowMs;while(performance.now()<until);},
  readRenderTargetPixelsAsync:(_t:unknown,_x:number,_y:number,w:number,h:number,bytes:Uint8Array)=>{assert.equal(current?.width,96,'the copy is queued while the portrait target is bound');return Promise.resolve().then(()=>{restored();for(let y=0;y<h;y++)for(let x=0;x<w;x++){const at=(y*w+x)*4;bytes[at]=y;bytes[at+3]=255;}return bytes;});},dispose:()=>{disposed=true;},
 };
 const restored=()=>{assert.equal(current,originalTarget);assert.deepEqual(actualViewport.toArray(),viewport.toArray());assert.deepEqual(actualScissor.toArray(),scissor.toArray());assert.equal(scissorTest,true);assert.equal(renderer.autoClear,false);assert.equal(disposed,false);};
 const body=new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(1,2,1),new THREE.MeshBasicMaterial()));
 body.name='actual-entity-body';body.userData.bodyModel='owned-model-instance';
 const prop=new THREE.Group();prop.name='activity prop: test-book';prop.add(new THREE.Mesh(new THREE.BoxGeometry(.1,.2,.1),new THREE.MeshBasicMaterial()));body.add(prop);
 const owner=new WorldSoulAvatars(renderer as unknown as THREE.WebGLRenderer);
 try{
  slowMs=6;await owner.capture('budget-first','bodyA',body,true,900);await owner.capture('budget-second','bodyA',body,true,900);
  assert.equal(soulAvatars.images.has('budget-first'),true);assert.equal(soulAvatars.images.has('budget-second'),false,'a frame past its portrait budget draws no more');
  await owner.capture('budget-second','bodyA',body,true,950);assert.equal(soulAvatars.images.has('budget-second'),true,'the next frame does');slowMs=0;
  for(const id of ['budget-first','budget-second']){soulAvatars.images.delete(id);soulAvatars.sources.delete(id);}
  await owner.capture('avatar-state-test','bodyA',body,true,1000);
  assert.equal(soulAvatars.images.get('avatar-state-test'),'data:image/png;base64,private-test');
  assert.deepEqual(soulAvatars.sources.get('avatar-state-test'),{entityId:'actual-entity-body',model:'owned-model-instance',bodyRoot:body.uuid});
  assert.equal((image as unknown as Uint8ClampedArray)[0],95,'WebGL bottom row flips to canvas top');
  restored();throwRender=true;await owner.capture('avatar-state-test','bodyB',body,true,1400);restored();assert.equal(soulAvatars.images.get('avatar-state-test'),undefined,'failed new body capture cannot retain a different old body portrait');owner.dispose();assert.equal(disposed,false,'view owns the shared renderer');
 }finally{globalThis.document=previousDocument;soulAvatars.images.delete('avatar-state-test');soulAvatars.sources.delete('avatar-state-test');originalTarget.dispose();body.traverse(o=>{const m=o as THREE.Mesh;if(m.isMesh){m.geometry.dispose();for(const mat of [m.material].flat())mat.dispose();}});}
});

test('a portrait is wanted while any of its avatars shows',()=>{
 const a=wantPortrait('wanted-test'),b=wantPortrait('wanted-test');
 assert.equal(soulAvatars.wanted.has('wanted-test'),true);a();assert.equal(soulAvatars.wanted.has('wanted-test'),true);b();assert.equal(soulAvatars.wanted.has('wanted-test'),false);
});

test('a newer capture for a Soul whose readback is still pending is drawn once it ends: the latest look wins',async()=>{
 const previousDocument=globalThis.document;
 globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:()=>{}}),toDataURL:()=>'data:image/png;base64,x'})} as unknown as Document;
 let current:THREE.WebGLRenderTarget|null=null;const reads:number[]=[];
 const renderer={autoClear:false,getRenderTarget:()=>current,getViewport:(o:THREE.Vector4)=>o,getScissor:(o:THREE.Vector4)=>o,getScissorTest:()=>false,setRenderTarget:(v:THREE.WebGLRenderTarget|null)=>{current=v;},setViewport:()=>{},setScissor:()=>{},setScissorTest:()=>{},render:()=>{},
  readRenderTargetPixelsAsync:(_t:unknown,_x:number,_y:number,_w:number,_h:number,b:Uint8Array)=>{reads.push(1);return new Promise(ok=>setTimeout(()=>ok(b),5));}};
 const make=()=>{const g=new THREE.Group();g.add(new THREE.Mesh(new THREE.BoxGeometry(1,2,1),new THREE.MeshBasicMaterial()));return g;};
 const a=make(),b=make(),c=make(),owner=new WorldSoulAvatars(renderer as unknown as THREE.WebGLRenderer);
 try{
  const first=owner.capture('picker-latest','lookA',a,true,1);
  const second=owner.capture('picker-latest','lookB',b,true,2),third=owner.capture('picker-latest','lookC',c,true,3);
  await third;
  assert.equal(soulAvatars.sources.get('picker-latest')?.bodyRoot,c.uuid,'the last caller, awaiting its own capture, sees its look');
  await Promise.all([first,second]);
  assert.equal(soulAvatars.sources.get('picker-latest')?.bodyRoot,c.uuid,'the latest look asked is the one shown');
  assert.equal(reads.length,2,'the look asked in between is skipped, not drawn');
 }finally{globalThis.document=previousDocument;soulAvatars.images.delete('picker-latest');soulAvatars.sources.delete('picker-latest');}
});
