/** Optional search cadence only. Page spacing is pressure, not presented FPS or camera attribution. */
export class FollowEffort {
 private state:'economical'|'reduced'='economical';private last:number|null=null;private pressure=0;private headroom=0;private sinceChange=0;private cause='default-unknown-device';
 reset(){this.last=null;this.pressure=this.headroom=this.sinceChange=0;this.state='economical';this.cause='default-unknown-device';}
 sample(at:number,cameraMs:number){
  const elapsed=this.last===null?NaN:at-this.last;this.last=Number.isFinite(at)?at:null;
  if(!Number.isFinite(cameraMs)||cameraMs<0||!Number.isFinite(elapsed)||elapsed<=0||elapsed>250){this.pressure=this.headroom=0;this.cause='sample-gap';return;}
  // A delayed callback contributes at most one ordinary low-cadence frame. Tab wake
  // cannot count as seconds of sustained pressure or recovery.
  const dt=Math.min(elapsed,50);this.sinceChange=Math.min(8000,this.sinceChange+dt);
  const cameraPressure=cameraMs>2,pagePressure=elapsed>33;
  // Good frames drain pressure at one quarter speed: alternating slow/fast frames
  // are sustained load, while an isolated spike still drains without demotion.
  this.pressure=cameraPressure||pagePressure?Math.min(2000,this.pressure+dt):Math.max(0,this.pressure-dt/4);
  this.headroom=cameraMs<1&&elapsed<25?Math.min(8000,this.headroom+dt):0;
  if(this.state==='economical'&&this.pressure>=2000){this.state='reduced';this.cause=cameraPressure?'camera-span-pressure':'page-spacing-pressure';this.sinceChange=this.pressure=this.headroom=0;}
  else if(this.state==='reduced'&&this.headroom>=8000&&this.sinceChange>=8000){this.state='economical';this.cause='sustained-headroom';this.sinceChange=this.pressure=this.headroom=0;}
 }
 get interval(){return this.state==='reduced'?.5:.25;}
 read(){return{state:this.state,reason:this.cause,searchSeconds:this.interval,pressureMs:this.pressure,headroomMs:this.headroom};}
}
