import * as THREE from 'three';
import {WorldVisibilityInstances} from './WorldVisibilityInstances.ts';
import {springAngle,springStep} from './camera-spring.ts';
import {SHOT_WEIGHTS,shotScore,walkingDrift,type ShotContext} from './shot-score.ts';
/** #2201 A4: the most the sky part (.5 when not looked at, 0 or 1 when it is) moves a shot's total (the smallest weight
 *  sum: no sun, not forced). */
const SKY_SWING=.5*SHOT_WEIGHTS.sky/(Object.values(SHOT_WEIGHTS).reduce((a,b)=>a+b,0)-SHOT_WEIGHTS.sun)+1e-9;
/** Camera-only sightline protection. Requested orbit/zoom survives temporary
 * obstruction; the rendered camera may move nearer or around a blocking post. */
/** VF6: Follow zoom bounds (metres from the Soul) and how long after the last drag/zoom the viewer's view is kept as is
 *  (#1316: a grace period long enough that no automatic move lands while the viewer is still between gestures). */
export const FOLLOW_MIN=2.4,FOLLOW_MAX=40;const USER_HOLD=1.5;
/** #1316: automatic moves are eased. The pull in through an opening (time constant, seconds; speed), and the cap on any
 *  automatic move in metres per second (faster while the sight is cut, so a wall is never stared at for long). #2201 A2:
 *  and the most it gains speed in metres per second each second, so even a hurried move starts as a glide. Viewer
 *  gestures stay immediate. */
const GLIDE={opening:.35,openingSpeed:5,speed:6,speedBlocked:12,accel:6,accelBlocked:24};
/** #2201 A2: the periods (seconds) of the critically damped spring that carries the camera on the sphere round the Soul:
 *  calm, blocked (the sight is cut by something in the way), and returning to the asked-for view. */
export const SPRING={calm:1.6,blocked:.6,returning:1.2};
/** #2201 A3: how long (s) a passing body may cut the held sightline before the camera reacts; how often (s) a forced
 *  camera probes its way back to the asked-for view, the least time between two returns, and the clearance (m) beyond
 *  the camera a rung of that ladder needs ("space allows"). */
export const DWELL=.5,RECOVER={probe:.5,gap:1.5,margin:.5};
/** #2201 A3: the most an automatic move's velocity (direction included) changes, in metres per second each second (A4: a
 *  little more while the sight is cut, so the scored views still clear a row of houses in time). */
const TURN=40,TURN_BLOCKED=55;
/** A body (a skinned figure) or anything marked cameraTransient moves through a view; walls, fixtures and ground stay. */
const transient=(o:THREE.Object3D)=>{for(let p:THREE.Object3D|null=o;p;p=p.parent)if((p as THREE.SkinnedMesh).isSkinnedMesh||p.userData.cameraTransient===true)return true;return false;};
/** #1316: a pull out is deliberate past these, summed over one gesture (input events less than GESTURE_GAP s apart):
 *  click jitter and a slip inside a pinch stay coupled, a slow trackpad zoom out or a slow drag still decouples. */
const PULL_OUT={ratio:1.05,angle:.05},GESTURE_GAP=.4;
/** Nearest the camera comes to the Soul when walls (a narrow room, a stair) leave no clear view farther out. */
export const FOLLOW_NEAR=1;
const NEAR=FOLLOW_NEAR;
export class WorldFollow {
  private requested:THREE.Vector3|null=null;
  private rendered:THREE.Vector3|null=null;
  private ray=new THREE.Raycaster();
  private instances=new WorldVisibilityInstances();
  private objects:THREE.Object3D[]=[];
  private hits:THREE.Intersection[]=[];
  /** #2201 A1: sightline rays cast so far, and in the last resolve call (the camera trace's cost meter). */
  private cast=0;
  rays=0;
  reset(){this.decoupled=false;this.gesture=null;this.opening=this.pulled=null;this.requested=this.rendered=this.chosen=this.previousTarget=null;this.userOrbited=false;this.lastSearch=-Infinity;this.chosenClear=false;this.velocity.set(0,0,0);this.still();this.userAt=-Infinity;this.instances.reset();
    this.cut.chosen=this.cut.rendered=null;this.challenger=null;this.forced=this.wide=false;this.heading=null;this.heldSky=null;this.driftTo=null;this.driftAt=-Infinity;this.recoverGoal=null;this.ladder=[];this.lastProbe=this.lastReturn=-Infinity;}
  /** #2201 A2: the spring's velocity on the sphere (rad/s for theta and phi, m/s for the radius). */
  private motion={theta:0,phi:0,radius:0};
  /** The camera's automatic speed on the last frame (m/s, relative to the Soul): the start of the acceleration cap. */
  private eyeSpeed=0;
  private eyeVelocity=new THREE.Vector3();
  private still(){this.motion.theta=this.motion.phi=this.motion.radius=0;this.eyeSpeed=0;this.eyeVelocity.set(0,0,0);}
  /** Same candidates as recursive intersectObjects, minus objects whose hits
   * opaque() always rejects: hidden ancestry or own cameraTransparent. */
  private collect(roots:readonly THREE.Object3D[]){
    this.objects.length=0;const seen=new Set<THREE.Object3D>();
    // Sprites (speech bubbles, labels) never block the camera, and Sprite.raycast needs raycaster.camera, which this ray lacks.
    const visit=(o:THREE.Object3D)=>{if(!o.visible||seen.has(o))return;seen.add(o);if(o.userData.cameraTransparent!==true&&!(o as THREE.Sprite).isSprite)this.objects.push(o);for(const c of o.children)visit(c);};
    for(const root of roots){let shown=true;for(let p=root.parent;p;p=p.parent)if(!p.visible)shown=false;if(shown)visit(root);}
    this.instances.retain(this.objects);
  }
  /** Body tracking changes the relative camera frame; it is not an orbit/zoom
   * gesture. Shift both offsets before evaluating actual user input. */
  shiftFrame(delta:THREE.Vector3){
    if(!delta.toArray().every(Number.isFinite))return;
    this.requested?.add(delta);this.rendered?.add(delta);
  }
  private opaque(object:THREE.Object3D){
    if(object.userData.cameraTransparent===true)return false;
    for(let o:THREE.Object3D|null=object;o;o=o.parent)if(!o.visible)return false;
    const materials=(object as THREE.Mesh).material;
    return !materials||[materials].flat().some(m=>!m.transparent||m.opacity>=.5);
  }
  /** How far out along `offset` the camera still sees the Soul (metres). Stops early once below `need` (a yes/no
   * question); `torso` casts the torso line alone (a cheap estimate for the wide search). */
  /** #2201 A3: with `classify`, limit() also sets reachStatic, the reach counting walls, fixtures and ground only (not
   * bodies), and stops early only once that is below `need`, so a body in the way can be told from a wall. Bodies then
   * count on the torso and head lines only. */
  private reachStatic=Infinity;
  private limit(target:THREE.Vector3,offset:THREE.Vector3,roots:readonly THREE.Object3D[],need=-Infinity,torso=false,classify=false){
    const distance=offset.length(),direction=offset.clone().normalize(),right=new THREE.Vector3(direction.z,0,-direction.x).normalize();let allowed=distance,fixed=distance;
    const reverse=direction.clone().negate(),far=distance+.25;
    // Torso, head and both shoulder edges. Ignore the selected body's own
    // render roots by supplying only architecture, components and fixtures.
    for(const [height,side] of torso?[[0,0]]:[[0,0],[.6,0],[-.45,0],[0,.24],[0,-.24]]){
      const point=target.clone().add(new THREE.Vector3(0,height,0)).addScaledVector(right,side);
      this.cast++;this.ray.set(point,direction);this.ray.near=.05;this.ray.far=far;
      // Nearest opaque hit, as intersectObjects(...).sort().find(opaque) would give.
      this.hits.length=0;for(let o=0;o<this.objects.length;o++)this.instances.intersect(this.objects[o],this.ray,this.hits,o);
      let nearest=Infinity,still=Infinity;
      for(const h of this.hits)if((h.distance<nearest||classify&&h.distance<still)&&this.opaque(h.object)){nearest=Math.min(nearest,h.distance);if(classify&&h.distance<still&&!transient(h.object))still=h.distance;}
      this.hits.length=0;
      // A ray from the body passes through the back of a one-sided wall (a hotel room wall, a tower) whose drawn
      // face looks out at the camera: what the camera sees. Cast torso and head back from the far end too; a drawn
      // face found there blocks every camera beyond it, however close to the body it is.
      if(side===0&&height>=0){
        this.cast++;this.ray.set(point.clone().addScaledVector(direction,far),reverse);this.ray.near=0;this.ray.far=far-.05;
        for(let o=0;o<this.objects.length;o++)this.instances.intersect(this.objects[o],this.ray,this.hits,o);
        for(const h of this.hits)if(this.opaque(h.object)){if(far-h.distance<nearest)nearest=far-h.distance;if(classify&&far-h.distance<still&&!transient(h.object))still=far-h.distance;}this.hits.length=0;
      }
      // classify: a body that only grazes an edge of the Soul (shoulder or hip rays) does not cut the held view
      if(classify&&(side!==0||height<0))nearest=still;
      if(nearest<Infinity)allowed=Math.min(allowed,Math.max(0,nearest-.25));
      if(classify&&still<Infinity)fixed=Math.min(fixed,Math.max(0,still-.25));
      if((classify?fixed:allowed)<need)break;
    }
    this.reachStatic=classify?fixed:allowed;
    return allowed;
  }
  /** QA2 F11: a camera that sees the Soul only through an opening (a doorway, a window) in a wall across the view
   * frames that wall, not the Soul. Two rays a frame-width apart (left and right of the sightline, at torso and head
   * height, cast both ways for one-sided walls) that both meet a face turned along the view mean the camera stands
   * beyond such a wall: the length along `offset` up to it (minus a margin, at least NEAR), else Infinity. Walls along the view (a
   * corridor, a house beside the Soul) do not count, nor a post on one side only, nor anything outdoors. */
  private throughOpening(target:THREE.Vector3,offset:THREE.Vector3):number{
    const length=offset.length(),dir=offset.clone().normalize(),right=new THREE.Vector3(dir.z,0,-dir.x);
    if(right.lengthSq()<1e-6||length<NEAR+.5)return Infinity;right.normalize();
    const normal=new THREE.Vector3(),instance=new THREE.Matrix4(),world=new THREE.Matrix4();
    const crossing=(h:THREE.Intersection)=>{if(!h.face||!this.opaque(h.object))return false;normal.copy(h.face.normal);
      const mesh=h.object as THREE.InstancedMesh;
      if(mesh.isInstancedMesh&&h.instanceId!==undefined){mesh.getMatrixAt(h.instanceId,instance);world.multiplyMatrices(mesh.matrixWorld,instance);}else world.copy(h.object.matrixWorld);
      return Math.abs(normal.transformDirection(world).dot(dir))>.7;};
    // Indoors only: something overhead (a ceiling, a roof; cast both ways for one-sided ones) within 8 m. Outdoors a
    // gap between two houses is left to the sightline search (it rises over them).
    const head=target.clone().add(new THREE.Vector3(0,.6,0)),up=new THREE.Vector3(0,1,0);let roofed=false;
    for(const [origin,direction] of [[head,up],[head.clone().addScaledVector(up,8),up.clone().negate()]] as const){
      this.cast++;this.ray.set(origin,direction);this.ray.near=0;this.ray.far=8;this.hits.length=0;
      for(let o=0;o<this.objects.length;o++)this.instances.intersect(this.objects[o],this.ray,this.hits,o);
      roofed||=this.hits.some(h=>this.opaque(h.object));this.hits.length=0;
    }
    if(!roofed)return Infinity;
    let nearest=Infinity;
    for(const side of [-1,1]){let sideHit=Infinity;
      for(const height of [0,.6]){
        const from=target.clone().add(new THREE.Vector3(0,height,0)),to=target.clone().addScaledVector(offset,1).addScaledVector(right,side*length*.45);
        const ray=to.clone().sub(from),far=ray.length();ray.normalize();
        for(const [origin,direction,flip] of [[from,ray,false],[to,ray.clone().negate(),true]] as const){
          this.cast++;this.ray.set(origin,direction);this.ray.near=0;this.ray.far=far;this.hits.length=0;
          for(let o=0;o<this.objects.length;o++)this.instances.intersect(this.objects[o],this.ray,this.hits,o);
          for(const h of this.hits)if(crossing(h)){const along=(flip?far-h.distance:h.distance)*ray.dot(dir);if(along>.3)sideHit=Math.min(sideHit,along);}
          this.hits.length=0;
        }
      }
      if(sideHit===Infinity)return Infinity;nearest=Math.min(nearest,sideHit);
    }
    // A Soul in the doorway itself (the wall nearer than NEAR) is left to the sightline search.
    return nearest-.25>=NEAR?nearest-.25:Infinity;
  }
  private opening:{at:number;cap:number}|null=null;
  private pulled:number|null=null;
  /** Length for an offset whose sight reaches only `reach`: in to the nearest wall (the camera never sits behind
   * one), not nearer than NEAR to the body; a Soul pressed into a solid keeps a readable FOLLOW_MIN instead. */
  private fit(length:number,reach:number){return reach>=NEAR?Math.min(length,reach):Math.min(length,FOLLOW_MIN);}
  /** Only actual control input changes the preferred view. Use the two offsets
   * around that input event, so ground fitting and collision correction are not
   * mistaken for a zoom, even when the viewer drags while near a wall. */
  userInput(before:THREE.Vector3,after:THREE.Vector3){
    if(![...before.toArray(),...after.toArray()].every(Number.isFinite)||before.length()<.01||after.length()<.01||before.distanceTo(after)<1e-5)return;
    this.requested??=before.clone();
    // #1316 (Gene): the rule is coupling. Following, the camera may come in close, even into a house after the Soul. A
    // deliberate pull out (zooming out, or dragging round) decouples it: from then on it stays where the viewer put it,
    // carried along with the Soul, and nothing pulls it back in. Follow again (a reset) couples it. Zooming in keeps it coupled.
    // Only the viewer's own steps count (each before..after pair), never what moved the camera between them (follow
    // motion, the search): a running turn and zoom over the gesture.
    if(!this.gesture||this.clock-this.userAt>GESTURE_GAP)this.gesture={turn:0,zoom:1};
    this.gesture.turn+=before.angleTo(after);this.gesture.zoom*=after.length()/before.length();
    if(this.gesture.zoom>PULL_OUT.ratio||this.gesture.turn>PULL_OUT.angle)this.decoupled=true;
    // Decoupled, the camera is exactly where the gesture put it (within the zoom bounds); coupled, the gesture scales the
    // asked-for distance, which the search comes back to.
    const length=this.decoupled?Math.max(FOLLOW_NEAR,Math.min(FOLLOW_MAX,after.length())):Math.max(FOLLOW_MIN,Math.min(FOLLOW_MAX,this.requested.length()*after.length()/before.length()));
    // The gesture chooses the displayed direction, including when a previous
    // collision search had moved it away from the old preferred direction.
    this.requested.copy(after).setLength(length);
    this.rendered=after.clone().setLength(this.decoupled?length:this.requested.length());
    this.chosen=null;this.userAt=this.clock;this.userOrbited=true;this.still();
  }
  private gesture:{turn:number;zoom:number}|null=null;
  /** #1316: true once the viewer pulled the camera out: it keeps their view, and occlusion never moves it. */
  get held(){return this.decoupled;}
  /** #1317: the offset the viewer asked for (the camera trace's desired pose), or null before the first frame. */
  get desired():THREE.Vector3|null{return this.requested;}
  private decoupled=false;
  /** #1316: what moved the camera on the last frame, and with what, for the camera trace (#1317). */
  rule:{name:'start'|'held'|'user'|'collision'|'opening'|'search'|'glide'|'recover'|'speed-cap';blocked?:boolean;reach?:number;cap?:number}={name:'start'};
  resolve(target:THREE.Vector3,actualOffset:THREE.Vector3,roots:readonly THREE.Object3D[],seconds:number):THREE.Vector3 {
    this.rays=0;if(!actualOffset.toArray().every(Number.isFinite)||actualOffset.length()<.01)return actualOffset.clone();
    if(!this.requested||!this.rendered)this.requested=actualOffset.clone();
    for(const root of roots)root.updateWorldMatrix(true,true);
    this.collect(roots);const cast=this.cast;
    try{return this.instances.withQuery(this.objects,()=>this.resolveCollected(target,roots,seconds));}finally{this.rays=this.cast-cast;}
  }
  // VF4 (Gene: Follow "goes crazy" in dense streets). The camera never snaps: it picks a clear viewpoint near the
  // requested one (rise first, then orbit a little; scored for clear sight, closeness to where the camera is, the
  // requested angle and staying behind the walk) with hysteresis, and glides there in spherical coordinates so it
  // moves around obstacles, never through them. Only the first frame after a (re)start is placed directly.
  private chosen:THREE.Vector3|null=null;
  private lastSearch=-Infinity;
  private chosenClear=false;
  private clock=0;
  private previousTarget:THREE.Vector3|null=null;
  private velocity=new THREE.Vector3();
  private userAt=-Infinity;
  private userOrbited=false;
  /** True while the viewer is dragging/zooming (and a moment after): their view is shown as is. */
  get userActive(){return this.clock-this.userAt<USER_HOLD;}
  private clear(target:THREE.Vector3,offset:THREE.Vector3,roots:readonly THREE.Object3D[]){const need=offset.length()-.01;return this.limit(target,offset,roots,need)>=need;}
  /** #2201 A3: occluder dwell. Is a held sightline (the chosen view, or the drawn one) still to be kept? A wall cuts it at
   * once; a body passing through it (bodies alone in the way) only once it has stayed in the way for DWELL. */
  private cut:{chosen:number|null;rendered:number|null}={chosen:null,rendered:null};
  private kept(key:'chosen'|'rendered',target:THREE.Vector3,offset:THREE.Vector3,roots:readonly THREE.Object3D[]){
    const need=offset.length()-.01;
    if(this.limit(target,offset,roots,need,false,true)>=need){this.cut[key]=null;return true;}
    if(this.reachStatic<need){this.cut[key]=null;return false;}
    this.cut[key]??=this.clock;return this.clock-this.cut[key]<DWELL;
  }
  /** #2201 A3: choice hysteresis: a clear view that beats the held one is taken only when the next search picks it again. */
  private challenger:THREE.Vector3|null=null;
  /** #2201 A3: forced is the camera held off the asked-for view because that was blocked (it rose, came in, or looked
   * all round); `wide` marks the all-round look. The ladder lists the rungs found clear at the last probe. */
  private forced=false;
  private wide=false;
  private recoverGoal:THREE.Vector3|null=null;
  private ladder:number[]=[];
  private lastProbe=-Infinity;
  private lastReturn=-Infinity;
  /** The point `f` (0..1) of the way from the held view `a` to the asked-for view `b` on the sphere round the Soul. */
  private between(a:THREE.Vector3,b:THREE.Vector3,f:number){
    const x=new THREE.Spherical().setFromVector3(a),y=new THREE.Spherical().setFromVector3(b),d=Math.atan2(Math.sin(y.theta-x.theta),Math.cos(y.theta-x.theta));
    return new THREE.Vector3().setFromSpherical(new THREE.Spherical(x.radius+(y.radius-x.radius)*f,x.phi+(y.phi-x.phi)*f,x.theta+d*f));
  }
  /** #2201 A3 (auto-camera note §3): while forced, every RECOVER.probe s probe four rungs from the held view toward the
   * asked-for one (25 % … 100 %). A rung counts when its sightline reaches RECOVER.margin past the camera ("space allows")
   * at two probes running, so a brief gap in a passage does not pull the camera down; the camera then springs to the
   * furthest such rung, at most once every RECOVER.gap s. Reaching the asked-for view ends the forced state. */
  private recover(target:THREE.Vector3,wanted:THREE.Vector3,roots:readonly THREE.Object3D[]){
    // only from a camera settled near its held view: a return never turns a move still under way
    if(!this.forced||!this.chosen||this.clock-this.lastProbe<RECOVER.probe||!this.rendered||this.rendered.angleTo(this.chosen)>.1)return;
    this.lastProbe=this.clock;
    const clear=[.25,.5,.75,1].filter(f=>{const rung=this.between(this.chosen!,wanted,f),need=rung.length()+RECOVER.margin;
      return this.limit(target,rung.setLength(need),roots,need-.01)>=need-.01;});
    const twice=clear.filter(f=>this.ladder.includes(f));this.ladder=clear;
    if(!twice.length||this.clock-this.lastReturn<RECOVER.gap)return;
    const f=Math.max(...twice);
    this.chosen=f===1?wanted.clone():this.between(this.chosen,wanted,f);this.recoverGoal=this.chosen;this.chosenClear=true;this.cut.chosen=null;
    this.lastReturn=this.clock;this.ladder=[];this.challenger=null;if(f===1)this.forced=false;
  }
  private candidates(wanted:THREE.Vector3){
    const s=new THREE.Spherical().setFromVector3(wanted),out:THREE.Vector3[]=[wanted.clone()];
    const at=(dTheta:number,dPhi:number,scale=1)=>new THREE.Vector3().setFromSpherical(new THREE.Spherical(s.radius*scale,Math.max(.15,Math.min(Math.PI*.48,s.phi+dPhi)),s.theta+dTheta));
    for(const dPhi of [-.25,-.5,-.75,-1.05,-1.4])out.push(at(0,dPhi));  // rise first; high views fly over streets and fences
    for(const dTheta of [.35,-.35,.7,-.7,1.05,-1.05])for(const dPhi of [0,-.3,-.6])out.push(at(dTheta,dPhi));
    for(const dPhi of [0,-.4])out.push(at(0,dPhi,.75));
    return out;
  }
  /** #2201 A4: the light and lens the shot score reads (LiveWorld sets them each frame): toward the sun, the daylight
   * (0..1, null without a sun) and the camera's vertical field of view in degrees. */
  view:{sun:THREE.Vector3|null;daylight:number|null;fov:number}={sun:null,daylight:null,fov:50};
  /** #2201 A4: the way the Soul last walked (flat, unit): its facing for the shot score; null before it has walked. */
  private heading:THREE.Vector3|null=null;
  /** #2201 A4: whether a ray from the head, continued away from a camera at `offset`, meets nothing in 60 m: sky or far
   * background behind the head. */
  private skyBehind(target:THREE.Vector3,offset:THREE.Vector3){
    const head=target.clone().add(new THREE.Vector3(0,.6,0)),direction=head.clone().sub(target.clone().add(offset)).normalize();
    this.cast++;this.ray.set(head,direction);this.ray.near=.3;this.ray.far=60;this.hits.length=0;
    for(let o=0;o<this.objects.length;o++)this.instances.intersect(this.objects[o],this.ray,this.hits,o);
    const free=!this.hits.some(h=>this.opaque(h.object));this.hits.length=0;return free;
  }
  /** #2201 A4: where the walking drift heads (an azimuth), checked every second: the nearer side-behind view when it is
   * clear, else the nearest clear of the far side-behind and straight behind (a street lined with houses), else the nearer. */
  private heldSky:{at:THREE.Vector3;t:number;sky:boolean}|null=null;
  /** #2201 A4: the last search tried the asked-for view and found it blocked (no extra rays: the search's own check). */
  private askedBlocked=false;
  private driftTo:number|null=null;
  private driftAt=-Infinity;
  private driftAim(target:THREE.Vector3,s:THREE.Spherical,roots:readonly THREE.Object3D[]){
    const h=this.heading!,near=walkingDrift(h,s.theta),yaw=Math.atan2(h.x,h.z),at=(theta:number)=>new THREE.Vector3().setFromSpherical(new THREE.Spherical(s.radius,s.phi,theta));
    // the torso line alone (two rays): a cheap look, once a second, at where the drift should head
    const open_=(theta:number)=>{const c=at(theta),need=c.length()-.01;return this.limit(target,c,roots,need,true)>=need;};
    if(open_(near))return near;
    const gap=(a:number)=>Math.abs(Math.atan2(Math.sin(a-s.theta),Math.cos(a-s.theta)));
    const open=[2*yaw-near,yaw+Math.PI].filter(open_).sort((a,b)=>gap(a)-gap(b));
    return open[0]??near;
  }
  private choose(target:THREE.Vector3,wanted:THREE.Vector3,roots:readonly THREE.Object3D[]){
    // #2201 A4: candidates are ranked by the shot score (face or profile, sky behind the head, the sun, framing, staying
    // put, the asked-for view); the sky ray is cast for the three best and the held view only. Cost is minus the score.
    const ctx:ShotContext={heading:this.heading,held:this.rendered,asked:wanted,sun:this.view.sun,daylight:this.view.daylight,fov:this.view.fov*Math.PI/180,forced:this.forced};
    const asked=this.candidates(wanted),ranked=asked.map(c=>({c,k:-shotScore(c,ctx).total})).sort((a,b)=>a.k-b.k);this.askedBlocked=false;
    // Hysteresis: the previous viewpoint, while it stays clear, is kept unless a clear candidate scores .12 better.
    let best:THREE.Vector3|null=null,bestCost=Infinity;const held=!!this.chosen&&this.kept('chosen',target,this.chosen,roots);
    if(held){
      // the held view's sky, looked at again once a second (or when the view changes)
      if(!this.heldSky||this.heldSky.at.distanceTo(this.chosen!)>.01||this.clock-this.heldSky.t>=1)this.heldSky={at:this.chosen!.clone(),t:this.clock,sky:this.skyBehind(target,this.chosen!)};
      best=this.chosen;bestCost=-shotScore(this.chosen!,{...ctx,sky:this.heldSky.sky}).total-.12;}
    // the sky part moves a total by at most SKY_SWING: cast the sky rays only when the best candidates could then win
    if(ranked[0]&&ranked[0].k-SKY_SWING<bestCost){for(const r of ranked.slice(0,3))r.k=-shotScore(r.c,{...ctx,sky:this.skyBehind(target,r.c)}).total;ranked.sort((a,b)=>a.k-b.k);}
    for(const {c,k} of ranked){if(k>=bestCost)break;if(this.clear(target,c,roots)){best=c;bestCost=k;break;}if(c===asked[0])this.askedBlocked=true;}
    // #2201 A3: a challenger to a held view that is still clear wins only at the second search running.
    if(held&&best!==this.chosen){const again=!!this.challenger&&this.challenger.distanceTo(best!)<.1;this.challenger=best!.clone();if(!again)return this.chosen!;}
    this.challenger=null;this.wide=false;
    if(best)return best;
    this.wide=true;
    // Nothing near the asked-for view is clear (a narrow room, a stair well, a Soul against walls): look all round,
    // low to high, for the view that sees farthest (to 5 m), the asked-for side preferred, and come in to its nearest
    // wall (fit). Kept by the hysteresis above while it stays clear, so this wide look runs once per change.
    const s=new THREE.Spherical().setFromVector3(wanted);let open:THREE.Vector3=wanted,score=-Infinity;
    for(let i=0;i<12;i++)for(const phi of [s.phi,1.3,.85,.4]){
      const c=new THREE.Vector3().setFromSpherical(new THREE.Spherical(s.radius,Math.max(.15,Math.min(Math.PI*.48,phi)),s.theta+i*Math.PI/6));
      const v=Math.min(5,this.limit(target,c,roots,-Infinity,true))-.4*wanted.angleTo(c);if(v>score){score=v;open=c;}}
    return open.clone().setLength(this.fit(open.length(),this.limit(target,open,roots)));
  }
  /** QA2 F11: come in through an opening (throughOpening), measured at the asked-for length every .2 s (so the
   * pulled-in camera does not stop seeing the wall and swing back out), gliding in quickly and holding there. */
  private inOpening(target:THREE.Vector3,dt:number):THREE.Vector3{
    const r=this.rendered!;
    if(!this.opening||this.clock-this.opening.at>=.2){
      const asked=r.clone().setLength(Math.max(r.length(),this.chosen?.length()??0,this.requested?.length()??0));
      this.opening={at:this.clock,cap:this.throughOpening(target,asked)};
    }
    const cap=this.opening.cap;
    if(cap===Infinity){this.pulled=null;return r;}
    // the glide outward (toward the asked-for length) keeps pushing; the pulled length moves only inward, to the cap
    const from=Math.min(r.length(),this.pulled??Infinity);
    this.pulled=from<=cap?from:dt>0?from-Math.min((from-cap)*-Math.expm1(-dt/GLIDE.opening),GLIDE.openingSpeed*dt):cap;  // eased, never a jump
    const before=r.length();r.setLength(Math.min(before,Math.max(this.pulled,cap)));
    if(r.length()<before-1e-6)this.rule={...this.rule,name:'opening',cap};
    return r;
  }
  private resolveCollected(target:THREE.Vector3,roots:readonly THREE.Object3D[],seconds:number):THREE.Vector3 {
    const dt=Number.isFinite(seconds)?Math.max(0,Math.min(.1,seconds)):0;this.clock+=dt;
    if(this.previousTarget&&dt>0){const v=target.clone().sub(this.previousTarget).divideScalar(dt);if(v.length()<20)this.velocity.lerp(v,-Math.expm1(-dt/.6));}
    this.previousTarget=target.clone();
    // A gentle drift while walking, only while the viewer has not orbited for a while. #2201 A4: to the side-behind (about
    // 110 degrees off the heading, the nearer side), where the face shows in profile, not straight behind.
    const speed=Math.hypot(this.velocity.x,this.velocity.z);
    if(speed>.6)this.heading=new THREE.Vector3(this.velocity.x,0,this.velocity.z).normalize();
    if(speed>.6&&!this.userOrbited&&dt>0){
      const s=new THREE.Spherical().setFromVector3(this.requested!);
      if(this.driftTo===null||this.clock-this.driftAt>=1){this.driftAt=this.clock;this.driftTo=this.driftAim(target,s,roots);}
      const side=this.driftTo;
      let d=side-s.theta;d=Math.atan2(Math.sin(d),Math.cos(d));s.theta+=Math.sign(d)*Math.min(Math.abs(d),.1*dt);this.requested!.setFromSpherical(s);
    }
    const wanted=this.requested!.clone();
    // #1316: decoupled, the viewer's view is the camera, exactly as they left it, carried along with the Soul.
    if(this.decoupled){this.rendered=wanted.clone();this.rule={name:'held'};this.still();return wanted;}
    // While the viewer's hand is on the camera, show their view; only a wall between camera and Soul pulls it in
    // (a collision camera). Their requested distance survives, and the search resumes from their angle after.
    if(this.userActive&&this.rendered){
      const reach=this.limit(target,this.rendered,roots),length=this.rendered.length();this.still();
      this.rendered.setLength(this.fit(length,reach));
      this.rule=this.rendered.length()<length-1e-6?{name:'collision',reach}:{name:'user'};
      return this.inOpening(target,dt).clone();
    }
    const previous=this.rendered?.clone();
    // Search again every .2 s, or at once when a clear viewpoint is cut (one with no clear view waits for the next search).
    const searching=!this.chosen||this.clock-this.lastSearch>=.2||this.chosenClear&&!this.kept('chosen',target,this.chosen,roots);
    if(searching){
      const next=this.choose(target,wanted,roots).clone();if(!this.chosen||next.distanceTo(this.chosen)>.01)this.cut.chosen=null;
      this.chosen=next;this.lastSearch=this.clock;this.chosenClear=this.kept('chosen',target,this.chosen,roots);
      // #2201 A3: forced off the asked-for view (it rose more than .3 rad, came in below .7 of the distance, or looked all
      // round) until the camera is back at it.
      const c=new THREE.Spherical().setFromVector3(this.chosen),w=new THREE.Spherical().setFromVector3(wanted);
      // #2201 A4: or turned more than .3 rad off it because it was blocked (the shot score may also turn by choice; the
      // search's own look at the asked-for view says which)
      if(this.wide||c.phi<w.phi-.3||c.radius<.7*w.radius||this.chosen.angleTo(wanted)>.3&&this.askedBlocked){
        if(!this.forced)this.lastReturn=this.clock;  // the first return, too, comes RECOVER.gap after the camera was forced
        this.forced=true;}
      else if(this.chosen.angleTo(wanted)<.02&&c.radius>.97*w.radius){if(this.forced)this.recoverGoal=this.chosen;this.forced=false;}  // the way back is a recovery too
    }
    if(!searching)this.recover(target,wanted,roots);  // #2201 A4: never in the same frame as a search, so the two costs don't add up
    const goal=this.chosen;
    this.rule={name:this.recoverGoal&&goal.distanceTo(this.recoverGoal)<.01?'recover':goal.distanceTo(wanted)>.01?'search':'glide'};
    if(!this.rendered){this.rendered=goal.clone();this.rule={name:'start'};this.still();}
    else{
      // Glide on the sphere around the Soul (around obstacles, not through them); hurry, never jump, when blocked.
      // #2201 A2: a critically damped spring on theta, phi and radius, exact at any frame rate: the camera eases out of
      // rest and into the goal, and its velocity carries over when the goal moves, so it never starts or stops abruptly.
      const blocked=!this.kept('rendered',target,this.rendered,roots);this.rule.blocked=blocked;
      const period=blocked?SPRING.blocked:this.rule.name==='glide'||this.rule.name==='recover'?SPRING.returning:SPRING.calm,m=this.motion;
      const a=new THREE.Spherical().setFromVector3(this.rendered),b=new THREE.Spherical().setFromVector3(goal);
      const theta=springAngle(a.theta,m.theta,b.theta,period,dt),phi=springStep(a.phi,m.phi,b.phi,period,dt),radius=springStep(a.radius,m.radius,b.radius,period,dt);
      a.theta=theta.x;a.phi=Math.max(1e-3,Math.min(Math.PI-1e-3,phi.x));a.radius=Math.max(.01,radius.x);m.theta=theta.v;m.phi=phi.v;m.radius=radius.v;
      this.rendered.setFromSpherical(a);
      // A glide that would carry a clear camera out through a wall (growing the radius in a narrow room before it
      // turns) stops at the wall instead. Only a small correction: a house that suddenly cuts the sight is left to
      // the hurried glide above, never a jump.
      if(!blocked){const length=this.rendered.length(),fitted=this.fit(length,this.limit(target,this.rendered,roots));
        if(fitted<length&&length-fitted<=.2){this.rendered.setLength(fitted);this.motion.radius=Math.min(0,this.motion.radius);}}
    }
    if(this.recoverGoal&&this.rendered.distanceTo(this.recoverGoal)<.05)this.recoverGoal=null;  // arrived: recovered
    const result=this.inOpening(target,dt);
    if(this.rule.name==='opening')this.motion.radius=Math.min(0,this.motion.radius);  // held in at the opening: no outward push stored up
    // Angular easing alone can travel metres in one frame on a wide orbit or
    // when the visibility search switches sides. Bound automatic motion in
    // metres/second as well; actual viewer gestures above remain immediate.
    if(previous&&dt>0){
      const top=this.rule.blocked?GLIDE.speedBlocked:GLIDE.speed,accel=this.rule.blocked?GLIDE.accelBlocked:GLIDE.accel;
      // the cap itself changes gently: a camera that was hurrying slows to a lower cap at the same rate, never in one frame
      const limit=Math.min(Math.max(top,this.eyeSpeed-accel*dt),this.eyeSpeed+accel*dt)*dt;
      if(previous.distanceTo(result)>limit){this.rule={...this.rule,name:'speed-cap'};
        const from=previous.length(),to=result.length(),rotation=new THREE.Quaternion().setFromUnitVectors(previous.clone().normalize(),result.clone().normalize());
        const arc=previous.angleTo(result)*Math.max(from,to)+Math.abs(to-from),fraction=Math.min(1,limit/arc);
        result.copy(previous).normalize().applyQuaternion(new THREE.Quaternion().slerp(rotation,fraction)).multiplyScalar(from+(to-from)*fraction);
        this.motion.theta*=fraction;this.motion.phi*=fraction;this.motion.radius*=fraction;  // the spring moves on at the capped speed
      }
      // #2201 A3: and its velocity turns gently too. A new goal (a search, a recovery) can point the move another way while
      // the speed is capped; the change of velocity, direction included, is held to TURN m/s per second.
      const velocity=result.clone().sub(previous).divideScalar(dt),change=velocity.clone().sub(this.eyeVelocity),most=(this.rule.blocked?TURN_BLOCKED:TURN)*dt;
      if(change.length()>most){velocity.copy(this.eyeVelocity).addScaledVector(change,most/change.length());result.copy(previous).addScaledVector(velocity,dt);this.rule={...this.rule,name:'speed-cap'};}
      this.eyeVelocity.copy(velocity);this.eyeSpeed=velocity.length();
    }
    return result.clone();
  }
}
