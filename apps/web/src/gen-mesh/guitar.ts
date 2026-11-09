import {pianoEndAt,pianoReadyAt,guitarStrums,GUITAR_FADE} from '../../../../mars/viewer/app/engine-view/piano-score.ts';
import {notesToSound,QueuedNotes,type Resident} from './sound-plan.ts';
/** A deterministic plucked string, damped by a Karplus–Strong loop. No samples or continuously running oscillator. */
export function guitarWave(midi:number,rate:number):Float32Array<ArrayBuffer>{
  const period=Math.max(2,Math.round(rate/(440*2**((midi-69)/12)))),line=new Float32Array(period),out=new Float32Array(Math.ceil(rate*1.8));
  let seed=(midi+1)*2654435761>>>0;
  for(let i=0;i<period;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;line[i]=(seed/2147483648-1)*.65;}
  let mean=0;for(const x of line)mean+=x;mean/=period;for(let i=0;i<period;i++)line[i]-=mean;
  for(let i=0;i<out.length;i++){const j=i%period,value=line[j];line[j]=.497*(value+line[(j+1)%period]);out[i]=value*Math.min(1,i/(rate*.002))*Math.min(1,(out.length-i)/(rate*.05));}
  return out;
}
/** Driven inside the existing resident pass; no entity scan, idle timer or per-instrument server state. */
export class GuitarAudio {
  private done=new Map<string,number>();
  private queued=new QueuedNotes<AudioBufferSourceNode>();
  private buffers=new Map<number,AudioBuffer>();
  private active=new Set<string>();
  private now=0;private at=0;
  near=false;
  begin(now:number,at:number){this.now=now;this.at=at;this.near=false;this.active.clear();}
  resident(r:Resident,gain:number,ctx:AudioContext,out:AudioNode){
    if(!r.body||gain<=.001)return;
    const body=r.body;this.active.add(body);this.near=true;
    const ready=pianoReadyAt(this.now,r.activityAge,GUITAR_FADE),end=pianoEndAt(this.now,r.activityLeft);
    for(const s of notesToSound(guitarStrums(body,this.now-.05,this.now+.35),ready,end,this.done,s=>`${body}:${s.t}`)){
      const at=this.at+Math.max(0,s.t-this.now),nodes:AudioBufferSourceNode[]=[];
      for(const [i,midi] of s.notes.entries()){
        // A strum rakes across the strings in 40 ms; all strings belong to the same visible stroke.
        let buffer=this.buffers.get(midi);
        if(!buffer||buffer.sampleRate!==ctx.sampleRate){buffer=ctx.createBuffer(1,Math.ceil(ctx.sampleRate*1.8),ctx.sampleRate);buffer.copyToChannel(guitarWave(midi,ctx.sampleRate),0);this.buffers.set(midi,buffer);}
        const src=ctx.createBufferSource(),vol=ctx.createGain();src.buffer=buffer;vol.gain.value=gain*s.vel*.45;
        src.connect(vol).connect(out);src.onended=()=>{src.disconnect();vol.disconnect();};src.start(at+i*.008);nodes.push(src);
      }
      // Cancellation includes all unstarted strings of this strum, even when its first string has begun.
      nodes.forEach((src,i)=>this.queued.add(body,at+i*.008,[src]));
    }
  }
  finish(){
    for(const node of this.queued.settle(this.at,this.active)){node.stop();node.disconnect();}
    for(const [key,t]of this.done)if(t<this.now-2)this.done.delete(key);
  }
  state(){return {near:this.near,scheduled:this.done.size,pending:this.queued.size,cachedStrings:this.buffers.size};}
}
