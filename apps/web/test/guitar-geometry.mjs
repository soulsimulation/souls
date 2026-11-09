// Geometry oracle independent of the pose solver: query actual rendered triangles, never pose goals.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {eachSkinnedWorld} from '../../../mars/viewer/app/engine-view/humans.ts';
const relevant=/^(LowerArm|Wrist|Thumb\d|Index\d|Middle\d|Ring\d|Pinky\d)(L|R)$/;
const distal=/^(Thumb3|Index4|Middle4|Ring4|Pinky4)(L|R)$/;
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
function solid(mesh,name){
 mesh.updateMatrix();const g=mesh.geometry,pos=g.attributes.position,I=g.index,points=Array.from({length:pos.count},(_,i)=>V().fromBufferAttribute(pos,i).applyMatrix4(mesh.matrix));
 const box=new THREE.Box3().setFromPoints(points),centre=box.getCenter(V()),planes=[],seen=new Set();
 for(let k=0;k<I.count;k+=3){const a=points[I.getX(k)],b=points[I.getX(k+1)],c=points[I.getX(k+2)];if(a.distanceToSquared(b)<1e-14||a.distanceToSquared(c)<1e-14||b.distanceToSquared(c)<1e-14)continue;const p=new THREE.Plane().setFromCoplanarPoints(a,b,c);if(p.normal.lengthSq()<.9)continue;if(p.distanceToPoint(centre)>0)p.negate();const key=[...p.normal.toArray(),p.constant].map(n=>n.toFixed(8)).join(',');if(!seen.has(key)){seen.add(key);planes.push(p);}}
 return {name,box,planes,centre,points};
}
function geometry(prop){
 // Rendered guitar consists of two closed body lobes followed by neck and headstock.
 assert.ok(prop.children.length>=10,'drawn guitar primitives available');
 const solids=prop.children.slice(0,4).map((m,i)=>solid(m,['body-lower','body-upper','neck','headstock'][i]));
 for(const name of ['guitar bridge','guitar nut']){const parts=prop.children.filter(o=>o.name===name);assert.equal(parts.length,1);solids.push(solid(parts[0],name));}
 const strings=[];
 for(const mesh of prop.children){if(!mesh.geometry?.isBufferGeometry)continue;mesh.updateMatrix();const g=mesh.geometry,pos=g.attributes.position,box=new THREE.Box3().setFromPoints(Array.from({length:pos.count},(_,i)=>V().fromBufferAttribute(pos,i).applyMatrix4(mesh.matrix))),size=box.getSize(V());
  if(size.y>.5&&size.x<.004&&size.z<.004){const c=box.getCenter(V());const idx=g.index,faces=[];for(let i=0;i<idx.count;i+=3)faces.push([0,1,2].map(j=>V().fromBufferAttribute(pos,idx.getX(i+j)).applyMatrix4(mesh.matrix)));strings.push({a:V(c.x,box.min.y,c.z),b:V(c.x,box.max.y,c.z),radius:Math.max(size.x,size.z)/2,faces});}
 }
 assert.equal(strings.length,6,'six actual drawn string boxes');return {solids,strings};
}
function depth(p,s){return -Math.max(...s.planes.map(q=>q.distanceToPoint(p)));}
function clipSegment(a,b,s,margin){
 let lo=0,hi=1;for(const p of s.planes){const da=p.distanceToPoint(a)+margin,db=p.distanceToPoint(b)+margin,d=db-da;
  if(Math.abs(d)<1e-12){if(da>0)return null;continue;}
  const t=-da/d;if(d<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);if(lo>hi)return null;
 }return hi-lo>1e-9?[lo,hi]:null;
}
function clipTriangle(a,b,c,s,margin){
 let poly=[a,b,c];for(const plane of s.planes){if(!poly.length)return poly;const next=[];
  for(let i=0;i<poly.length;i++){const p=poly[i],q=poly[(i+1)%poly.length],dp=plane.distanceToPoint(p)+margin,dq=plane.distanceToPoint(q)+margin;
   if(dp<=0)next.push(p);if((dp<=0)!==(dq<=0))next.push(p.clone().lerp(q,dp/(dp-dq)));
  }poly=next;
 }return poly;
}
function segDist(a,b,c,d){
 const u=b.clone().sub(a),v=d.clone().sub(c),w=a.clone().sub(c),A=u.dot(u),B=u.dot(v),C=v.dot(v),D=u.dot(w),E=v.dot(w),den=A*C-B*B;
 let s=den>1e-18?Math.max(0,Math.min(1,(B*E-C*D)/den)):0,t=C>1e-18?(B*s+E)/C:0;
 if(t<0){t=0;s=A>1e-18?Math.max(0,Math.min(1,-D/A)):0;}else if(t>1){t=1;s=A>1e-18?Math.max(0,Math.min(1,(B-D)/A)):0;}
 return a.clone().addScaledVector(u,s).distanceTo(c.clone().addScaledVector(v,t));
}
function triangleString(a,b,c,s){
 const tri=new THREE.Triangle(a,b,c),normal=tri.getNormal(V()),den=normal.dot(s.b.clone().sub(s.a));
 if(Math.abs(den)>1e-12){const t=normal.dot(a.clone().sub(s.a))/den;if(t>=0&&t<=1&&tri.containsPoint(s.a.clone().lerp(s.b,t)))return 0;}
 let d=Math.min(tri.closestPointToPoint(s.a,V()).distanceTo(s.a),tri.closestPointToPoint(s.b,V()).distanceTo(s.b));
 for(const [p,q] of [[a,b],[b,c],[c,a]])d=Math.min(d,segDist(p,q,s.a,s.b));return Math.max(0,d-s.radius);
}
function triangleMeshDistance(p,faces){
let best=Infinity;for(const q of faces){for(let i=0;i<3;i++){best=Math.min(best,triangleString(...p,{a:q[i],b:q[(i+1)%3],radius:0}),triangleString(...q,{a:p[i],b:p[(i+1)%3],radius:0}));if(best<1e-12)return 0;}}return best;
}
function topology(view,side='R'){
 const refs=[];view.rig.model.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;const g=mesh.geometry,si=g.attributes.skinIndex,sw=g.attributes.skinWeight,selected=new Set(),labels=new Map(),tips=new Map();
  for(let i=0;i<si.count;i++){const names=[];let maxWeight=-1,dominant='';for(let k=0;k<4;k++){const w=sw.getComponent(i,k),name=mesh.skeleton.bones[si.getComponent(i,k)]?.name??'';if(w>maxWeight){maxWeight=w;dominant=name;}if(w>0&&relevant.test(name))names.push(name);}if(names.length){selected.add(i);labels.set(i,{dominant,influences:names});}if(distal.test(dominant))tips.set(i,dominant);}
  const I=g.index,triangles=[],tipTriangles=[];for(let k=0;k<(I?.count??si.count);k+=3){const ids=[0,1,2].map(j=>I?I.getX(k+j):k+j);if(ids.some(i=>selected.has(i)))triangles.push(ids);if(ids.some(i=>tips.get(i)?.endsWith(side)))tipTriangles.push(ids);}
  const needed=new Set([...triangles.flat(),...tipTriangles.flat()]);if(needed.size)refs.push({mesh,idx:[...needed],triangles,tipTriangles,labels,tips});
 });return refs;
}
function skin(refs,inv){
 return refs.map(r=>{const points=new Map();let n=0;eachSkinnedWorld([r],V(),p=>points.set(r.idx[n++],p.clone().applyMatrix4(inv)));return {...r,points};});
}
function collisions(refs,solids,margin){
 const out={vertexHits:0,edgeHits:0,triangleHits:0,vertexOnlyMisses:0,maxDepth:0,worst:null,bySolid:{},bySide:{left:0,right:0,mixed:0}};
 for(const r of refs)for(const ids of r.triangles){const p=ids.map(i=>r.points.get(i)),box=new THREE.Box3().setFromPoints(p);
  for(const s of solids){if(!box.intersectsBox(s.box))continue;const depths=p.map(v=>depth(v,s)),vertex=depths.some(d=>d>margin),poly=clipTriangle(...p,s,margin);if(poly.length<3)continue;
   const edges=[[0,1],[1,2],[2,0]].some(([a,b])=>clipSegment(p[a],p[b],s,margin));const q=poly.reduce((a,p)=>a.add(p),V()).divideScalar(poly.length),max=Math.max(depth(q,s),...depths);out.triangleHits++;if(vertex)out.vertexHits++;else out.vertexOnlyMisses++;if(edges)out.edgeHits++;
   out.bySolid[s.name]=(out.bySolid[s.name]??0)+1;const names=ids.flatMap(i=>r.labels.get(i)?.influences??[]),sides=new Set(names.map(n=>n.at(-1))),side=sides.size===1?(sides.has('R')?'right':'left'):'mixed';out.bySide[side]++;
   if(max>out.maxDepth){out.maxDepth=max;out.worst={solid:s.name,side,indices:ids,labels:ids.map(i=>r.labels.get(i)??null),local:q.toArray(),depth:max};}
  }
 }return out;
}
function fingertipDistances(refs,strings){
 const best=strings.map(()=>({distance:Infinity,bone:null,indices:null}));for(const r of refs)for(const ids of r.tipTriangles){const p=ids.map(i=>r.points.get(i));for(let i=0;i<strings.length;i++){const d=triangleMeshDistance(p,strings[i].faces);if(d<best[i].distance)best[i]={distance:d,bone:ids.map(i=>r.tips.get(i)).find(Boolean),indices:ids};}}
 return best;
}
function controls(solids,strings){
 const reports=[];for(const s of [solids[0],solids[2]]){assert.ok(depth(s.centre,s)>0);const size=s.box.getSize(V()),a=s.centre.clone().setX(s.box.min.x-1),b=s.centre.clone().setX(s.box.max.x+1);assert.ok(depth(a,s)<0&&depth(b,s)<0);assert.ok(clipSegment(a,b,s,.001));
  const outA=a.clone().setZ(s.box.max.z+1),outB=b.clone().setZ(s.box.max.z+1);assert.equal(clipSegment(outA,outB,s,.001),null);
  const x=s.box.max.x,tangentA=V(x,s.box.min.y-1,s.centre.z),tangentB=V(x,s.box.max.y+1,s.centre.z);assert.equal(clipSegment(tangentA,tangentB,s,.001),null);
  const z=s.centre.z,poly=clipTriangle(V(-2,-2,z),V(2,-2,z),V(0,3,z),s,.001);assert.ok(poly.length>=3,'triangle interior intersection found with all vertices outside');reports.push({solid:s.name,inside:true,outside:true,crossingEdge:true,frontContactClear:true,enclosingTriangle:true});}
 const line={a:V(0,-1,0),b:V(0,1,0),radius:0},tri=[V(0,0,0),V(0,.1,.1),V(0,-.1,.1)];assert.equal(triangleString(...tri,line),0);assert.ok(Math.abs(triangleString(...tri.map(p=>p.clone().add(V(.02,0,0))),line)-.02)<1e-9);const string=strings[0],centre=string.a.clone().lerp(string.b,.5),front=Math.max(...string.faces.flat().map(p=>p.x));const t=[V(front,centre.y-.01,centre.z-.01),V(front,centre.y+.01,centre.z-.01),V(front,centre.y,centre.z+.01)];assert.ok(triangleMeshDistance(t,string.faces)<1e-9);assert.ok(Math.abs(triangleMeshDistance(t.map(p=>p.clone().add(V(.02,0,0))),string.faces)-.02)<1e-9);reports.push({stringContact:true,stringGap20mm:true,actualStringTriangleContact:true,actualStringTriangleGap20mm:true});return reports;
}

export {geometry,topology,skin,collisions,fingertipDistances,controls};
export function assertGuitarGeometry(view,{contact=false}={}){
 const holder=view.rig.holder;holder.updateMatrixWorld(true);
 const prop=holder.getObjectByName('activity prop: guitar');assert.ok(prop?.visible,'opaque full-sized guitar remains visible');
 const geo=geometry(prop),scale=view.rig.template.bodyScale??1,inv=prop.matrixWorld.clone().invert();
 const c=collisions(skin(topology(view),inv),geo.solids,.001/scale);
 assert.equal(c.triangleHits,0,`whole bilateral forearm/wrist/hand skin clears instrument solids: ${JSON.stringify(c.worst)}`);
 if(contact)for(const side of ['L','R']){
  const ds=fingertipDistances(skin(topology(view,side),inv),geo.strings);
  assert.ok(Math.min(...ds.map(d=>d.distance*scale))<=.003,`${side} distal rendered skin contacts actual drawn strings within3mm (nearest ${Math.min(...ds.map(d=>d.distance*scale))}m)`);
 }
 return geo;
}
