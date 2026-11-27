/** Observe the final drawn holder matrix. Bounded subject-local geometry traversal; no pose update, clock, RNG, camera or world mutation. */
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import type { Mesh, Object3D, SkinnedMesh } from 'three';
import type { CameraObservation, CameraSubject, CameraVersion, CameraBounds, CameraVec3 } from '../../../../packages/camera/src/observation.ts';
export type DrawnSubject = { id: string; root: Object3D | null; bounds?: CameraBounds | null;
  /** Only known renderer conventions; never the take's travel heading. */
  forwardLocal?: CameraVec3 | null;
  activity?: { kind: string; partner?: string; object?: string; validThroughSeconds?: number } | null;
  carrier?: { subject: string; relation: 'aboard' | 'seated' | 'carried'; confidence: number } | null;
};
export type DrawnFrame = { version: CameraVersion; tick: number; seconds: number; subjects: Iterable<DrawnSubject>; /** Explicit vertex/corner work allowance, shared across subjects. */ geometryWork?: number };
type Piece = { box: Box3; mesh: Mesh; bone?: Object3D };
/** Cache only geometry/bind-space envelopes. Per-frame bounds transform cached corners with the drawn bone matrices.
 * A weighted skinned vertex is a convex combination of those bone envelopes, so their union is conservative. */
export class DrawGeometry {
  private cache = new WeakMap<Object3D, { signature: unknown[]; pieces: Piece[]; head: Object3D | null; mesh: number; vertex: number; boxes: Box3[]; complete: boolean }>();
  private point = new Vector3(); private matrix = new Matrix4(); private local = new Matrix4(); private box = new Box3();
  inspect(root: Object3D, position: Vector3, rotation: Quaternion, canonical: boolean, grant: { remaining: number }) {
    // Observe only this representation. A changing mesh/attribute/bind layout invalidates unfinished and completed detail.
    const meshes: SkinnedMesh[] = [], signature: unknown[] = [], pending = [root]; let visited=0;
    while(pending.length && visited++ < 256) {
      const object=pending.pop()!; pending.push(...object.children);
      const mesh=object as SkinnedMesh;if(!mesh.isMesh||!mesh.geometry?.attributes.position)continue;
      meshes.push(mesh);signature.push(mesh,mesh.geometry,mesh.skeleton,...mesh.bindMatrix?.elements??[]);
      for(const key of ['position','skinIndex','skinWeight']) { const a=mesh.geometry.attributes[key];signature.push(a,a && ('version' in a?a.version:a.data.version),a?.count); }
    }
    if(pending.length) return {bounds:null,head:null}; // oversized representations decline detail, never scan without a bound
    let c=this.cache.get(root);
    if(!c || signature.length!==c.signature.length || signature.some((v,i)=>v!==c!.signature[i])) {
      c={signature,pieces:[],head:null,mesh:0,vertex:0,boxes:[],complete:false};this.cache.set(root,c);
    }
    while(c.mesh<meshes.length) {
      const mesh=meshes[c.mesh], points=mesh.geometry.attributes.position,indices=mesh.geometry.attributes.skinIndex,weights=mesh.geometry.attributes.skinWeight;
      const skinned=mesh.isSkinnedMesh&&indices&&weights;
      if(!c.boxes.length)c.boxes=skinned?mesh.skeleton.bones.map(()=>new Box3()):[new Box3()];
      while(c.vertex<points.count && grant.remaining >= (skinned?4:1)) {
        const i=c.vertex++;grant.remaining-=skinned?4:1;
        if(skinned)for(let j=0;j<4;j++) {if(weights.getComponent(i,j)<=0)continue;const k=indices.getComponent(i,j);if(!c.boxes[k])continue;
          this.point.fromBufferAttribute(points,i).applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.skeleton.boneInverses[k]);c.boxes[k].expandByPoint(this.point);}
        else c.boxes[0].expandByPoint(this.point.fromBufferAttribute(points,i));
      }
      if(c.vertex<points.count)return {bounds:null,head:null};
      for(const [i,box] of c.boxes.entries())if(!box.isEmpty())c.pieces.push({box,mesh,...(skinned?{bone:mesh.skeleton.bones[i]}:{})});
      if(canonical&&skinned&&['Body','Abdomen','Torso','Head'].every(name=>mesh.skeleton.bones.some(b=>b.name===name)))c.head=mesh.skeleton.bones.find(b=>b.name==='Head')??null;
      c.mesh++;c.vertex=0;c.boxes=[];
    }
    c.complete=true;
    if(grant.remaining<c.pieces.length*8)return {bounds:null,head:null};
    grant.remaining-=c.pieces.length*8;
    const inverse=rotation.clone().invert();this.local.makeRotationFromQuaternion(inverse);this.local.setPosition(this.point.copy(position).negate().applyQuaternion(inverse));this.box.makeEmpty();
    for(const piece of c.pieces) {
      if(!drawnVisible(piece.mesh))continue;this.matrix.copy(piece.mesh.matrixWorld);
      if(piece.bone)this.matrix.multiply((piece.mesh as SkinnedMesh).bindMatrixInverse).multiply(piece.bone.matrixWorld);
      this.matrix.premultiply(this.local);
      for(let i=0;i<8;i++)this.box.expandByPoint(this.point.set(i&1?piece.box.max.x:piece.box.min.x,i&2?piece.box.max.y:piece.box.min.y,i&4?piece.box.max.z:piece.box.min.z).applyMatrix4(this.matrix));
    }
    const head=c.head&&drawnVisible(c.head)?this.point.setFromMatrixPosition(c.head.matrixWorld).applyMatrix4(this.local).toArray() as [number,number,number]:null;
    return {bounds:this.box.isEmpty()?null:{min:this.box.min.toArray() as [number,number,number],max:this.box.max.toArray() as [number,number,number]},head};
  }
}
export function drawnVisible(root: Object3D | null): root is Object3D { for (let o=root;o;o=o.parent) if (!o.visible) return false; return root !== null; }
export function drawnRepresentation(...roots: (Object3D|null|undefined)[]) { return roots.find((root): root is Object3D => !!root && drawnVisible(root)) ?? null; }
export type ObservationResult = { status: 'observed'; value: CameraObservation } | { status: 'rejected'; reason: 'camera.frame-invalid' | 'camera.frame-out-of-order' };
export type Movement = { state: 'travel' | 'activity' | 'stationary' | 'unknown'; activity: string | null; speedMps: number | null };
type Previous = { seconds: number; p: CameraVec3 };
export class DisplayedCameraObserver {
  private geometry = new DrawGeometry();
  private identity = ''; private tick = -Infinity; private previous = new Map<string, Previous>();
  private position = new Vector3(); private rotation = new Quaternion(); private scale = new Vector3(); private direction = new Vector3();
  readonly movement = new Map<string, Movement>();
  readonly unsupported = new Map<string, string>();
  capture(frame: DrawnFrame): ObservationResult {
    if (![frame.tick, frame.seconds].every(Number.isFinite) || frame.seconds < 0) return { status: 'rejected', reason: 'camera.frame-invalid' };
    const identity = JSON.stringify(frame.version);
    if (identity === this.identity && frame.tick < this.tick) return { status: 'rejected', reason: 'camera.frame-out-of-order' };
    if (identity !== this.identity) { this.previous.clear(); this.movement.clear(); this.identity = identity; }
    this.tick = frame.tick;
    const subjects: CameraSubject[] = [], active = new Set<string>();
    const grant={remaining:Math.max(0,Math.min(65536,Math.floor(frame.geometryWork??2048)))};this.unsupported.clear();
    for (const subject of frame.subjects) {
      active.add(subject.id);
      const root = subject.root;
      if (!drawnVisible(root)) { subjects.push({ id: subject.id, version: frame.version, state: 'unavailable', reason: 'not-loaded' }); this.previous.delete(subject.id); this.movement.delete(subject.id); continue; }
      // Renderer already composed this matrix for the draw. getWorldPosition/updateMatrixWorld would change held rigs.
      root.matrixWorld.decompose(this.position, this.rotation, this.scale); this.rotation.normalize();
      const m=root.matrixWorld.elements, x=new Vector3(m[0],m[1],m[2]).normalize(),y=new Vector3(m[4],m[5],m[6]).normalize(),z=new Vector3(m[8],m[9],m[10]).normalize();
      if (![...m].every(Number.isFinite)||Math.min(...this.scale.toArray().map(Math.abs))<1e-12||Math.max(Math.abs(x.dot(y)),Math.abs(x.dot(z)),Math.abs(y.dot(z)))>1e-6) {this.unsupported.set(subject.id,'camera.subject-transform-unsupported');this.previous.delete(subject.id);this.movement.delete(subject.id);continue;}
      const geometry=this.geometry.inspect(root,this.position,this.rotation,!!subject.forwardLocal,grant);
      const p = this.position.toArray() as [number, number, number], old = this.previous.get(subject.id);
      const elapsed = old ? frame.seconds - old.seconds : 0;
      const velocity = old && elapsed > 0 ? p.map((v, i) => (v - old.p[i]) / elapsed) as [number, number, number] : null;
      const speed = velocity ? Math.hypot(...velocity) : null;
      const a = subject.activity, fresh = a && (a.validThroughSeconds === undefined || frame.seconds <= a.validThroughSeconds);
      const meaningful = fresh && !['idle', 'walk', 'stand'].includes(a.kind);
      this.movement.set(subject.id, { state: speed === null ? 'unknown' : speed > .02 ? 'travel' : meaningful ? 'activity' : 'stationary', activity: fresh ? a.kind : null, speedMps: speed });
      if (elapsed > 0 || !old) this.previous.set(subject.id, { seconds: frame.seconds, p });
      const facing = subject.forwardLocal ? { value: this.direction.fromArray(subject.forwardLocal).transformDirection(root.matrixWorld).toArray() as [number, number, number], confidence: 1, source: 'displayed' as const } : null;
      subjects.push({ id: subject.id, version: frame.version, state: 'present', confidence: 1,
        transform: { positionM: p, rotationXyzw: this.rotation.toArray() }, bounds: geometry.bounds ?? subject.bounds ?? null,
        anchors: [{ role: 'root', localM: [0, 0, 0], confidence: 1 }, ...(geometry.head ? [{role:'head' as const,localM:geometry.head,confidence:1}] : [])], facing,
        travelMps: velocity ? { value: velocity, confidence: 1, source: 'derived' } : null,
        activity: fresh ? { kind: a.kind, roles: [{ role: 'actor', subject: subject.id }, ...(a.partner ? [{ role: 'partner' as const, subject: a.partner }] : []), ...(a.object ? [{ role: 'object' as const, subject: a.object }] : []), ...(subject.carrier ? [{ role: 'carrier' as const, subject: subject.carrier.subject }] : [])] } : null,
        carrier: subject.carrier ? { state: 'attached', ...subject.carrier } : null });
    }
    // Keep only this displayed audience: removed subjects cannot retain velocity or stale activities indefinitely.
    for (const id of this.previous.keys()) if (!active.has(id)) { this.previous.delete(id); this.movement.delete(id); }
    return { status: 'observed', value: { schema: 'camera-observation/1', version: frame.version, audience: 'public', coordinateFrame: 'world-y-up-rh', units: { distance: 'm', time: 's', angle: 'rad' }, depicted: { tick: frame.tick, seconds: frame.seconds }, coverage: 'partial', subjects } };
  }
}
/** Only explicit take fields become roles; names, proximity and travel yaw carry no semantic authority. */
export function drawnActivity(kind: unknown, state: Readonly<Record<string, unknown>>) {
  return typeof kind === 'string' && kind ? { kind, ...(typeof state.partner === 'string' ? { partner: state.partner } : {}) } : null;
}

/** Activity is valid only inside the actual displayed take coverage, including history. No wall-time TTL. */
export function drawnTakeActivity(kind: unknown, state: Readonly<Record<string, unknown>>, take: {startTick:number;ticks:number;dt:number}|null) {
 const activity=drawnActivity(kind,state);return activity&&take?{...activity,validThroughSeconds:(take.startTick+take.ticks)*take.dt}:null;
}
