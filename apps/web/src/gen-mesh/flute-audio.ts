import {fluteNotes,FLUTE_FADE,pianoReadyAt,pianoEndAt} from '../../../../mars/viewer/app/engine-view/piano-score.ts';
import {falloff,notesToSound,QueuedNotes,type Resident} from './sound-plan.ts';

/** The existing score rendered as a soft fundamental, quiet octave and vibrato. */
function fluteTone(c:AudioContext,out:AudioNode,at:number,midi:number,peak:number){
 const hz=440*2**((midi-69)/12),gain=c.createGain(),nodes:OscillatorNode[]=[];
 gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(Math.max(.0002,peak),at+.035);gain.gain.setValueAtTime(Math.max(.0002,peak*.85),at+.14);gain.gain.exponentialRampToValueAtTime(.0001,at+.25);gain.connect(out);
 for(const [ratio,level]of [[1,1],[2,.08]]){const o=c.createOscillator(),g=c.createGain();o.type='sine';o.frequency.setValueAtTime(hz*ratio,at);g.gain.value=level;o.connect(g).connect(gain);o.start(at);o.stop(at+.28);nodes.push(o);}
 const vibrato=c.createOscillator(),depth=c.createGain();vibrato.frequency.value=5;depth.gain.value=hz*.002;vibrato.connect(depth).connect(nodes[0].frequency);vibrato.start(at);vibrato.stop(at+.28);nodes.push(vibrato);return nodes;
}
/** Existing resident list only; no model/entity scan. Unstarted notes lose ownership immediately on stop/mute. */
export class FluteAudio{
 private done=new Map<string,number>();private queued=new QueuedNotes<OscillatorNode>();near=false;
 update(c:AudioContext,out:AudioNode,now:number,audioNow:number,residents:readonly Resident[],listener:readonly number[],muted=false){
  this.near=false;const playing=new Set<string>();
  if(!muted)for(const r of residents){
   if(r.activity!=='play-music'||r.instrument!=='flute'||!r.body)continue;
   const gain=falloff(Math.hypot(r.p[0]-listener[0],r.p[1]-listener[1],r.p[2]-listener[2]),24,.42);if(gain<=.001)continue;
   this.near=true;playing.add(r.body);
   const ready=pianoReadyAt(now,r.activityAge,FLUTE_FADE),end=pianoEndAt(now,r.activityLeft);
   for(const n of notesToSound(fluteNotes(r.body,now-.05,now+.35),ready,end,this.done,n=>`${r.body}:${n.t}`)){
    const at=audioNow+Math.max(0,n.t-now);this.queued.add(r.body,at,fluteTone(c,out,at,n.midi,gain*n.vel*.26));
   }
  }
  for(const node of this.queued.settle(audioNow,playing))node.disconnect();
  for(const[k,t]of this.done)if(t<now-2)this.done.delete(k);
 }
 state(){return{near:this.near,scheduled:this.done.size,queued:this.queued.size};}
}
