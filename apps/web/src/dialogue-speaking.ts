/** DLG3 head pop-ups: who is speaking right now, published by the dialogue dock (which owns threads and
 * their colours) and painted by LiveWorld into each Soul's speech bubble, anchored above its head and apart from
 * its name tag (the tag hangs under the body since C2). A fresh line from a nearby, on-screen speaker shows for
 * several seconds as a compact pop-up there. A distant speaker (no pop-up) gets a small dot instead, which fades out; a
 * line that popped up leaves no dot behind (first-day round 2: a pink dot stayed over the head after the bubble closed).
 * Clicking the pop-up or the dot opens that conversation in the dock. */
export type Speaking={colour:string;since:number;thread:string;
 /** The line itself (DLG3 pop-up); absent for older publishers. */
 text?:string;private?:boolean;key?:string};
/** soulId → latest spoken line, `since` on the performance.now() clock. */
export const speakingNow=new Map<string,Speaking>();
/** Bumped each time a new line is put in `speakingNow`, so the page paints its pop-up on the next frame, not at its next
 *  quarter-second refresh (trial of 0.137: the bubble came about 2.5 s after `say`). */
export const speakingClock={version:0};
/** Put `soulId`'s newest line up: it shows from the next frame. */
export function speakNow(soulId:string,s:Speaking){speakingNow.set(soulId,s);speakingClock.version++;pass.at=-Infinity;}
/** Dot stays this long after a line, fading out over its last DOT_FADE_MS; pulses for the first PULSE_MS. */
export const SPEAKING_SHOW_MS=15_000;
export const DOT_FADE_MS=4_000;
export const SPEAKING_PULSE_MS=3_500;
/** Speakers farther from the camera than this get no pop-up (the dot and the thread only). */
export const POPUP_NEAR_M=48;
/** At most this many pop-ups at once (newest first); phones get fewer. */
export const POPUP_MAX=4,POPUP_MAX_PHONE=2;
/** How long a line stays up: at least 9 s, longer for long lines (75 ms a character, slow reading, read twice over a
 *  moving picture), never more than 16 s (trial of 0.137: a line began to fade at about 7 s, before it was read). */
export const popupMs=(text:string)=>Math.min(16_000,Math.max(9_000,2_500+text.length*75));
const POPUP_FADE_MS=600;

/** How high over a person's body point (the floor under it, seated too) its speech bubble's tail sits (m): just over the head it is drawn with. Seated or
 *  lying, the head is lower (trial of 0.137: a seated speaker's bubble floated well above its head). */
const SEATED_POSES=new Set(['sit','sit-ground']),LYING_POSES=new Set(['lie','sleep','nap','stargaze','pushups','situps']);
export const bubbleLift=(activity:string|null|undefined)=>{const a=(activity??'').replace(/^mars:/,'');return SEATED_POSES.has(a)?1.35:LYING_POSES.has(a)?0.9:1.9;};
/** Requests from a pop-up or dot click: open the dock on this thread. */
export const dialogueRequests=new EventTarget();
export const requestSoulConversations=(soulId:string)=>dialogueRequests.dispatchEvent(new CustomEvent('open-soul',{detail:soulId}));
export const requestThread=(thread:string)=>dialogueRequests.dispatchEvent(new CustomEvent('open-thread',{detail:thread}));

/** Where each painted speaker was last seen (near and drawn), so the per-pass cap can prefer the newest lines. */
const seen=new Map<string,{at:number;eligible:boolean}>();
/** soulId → the key of its last line that was shown as a pop-up: that line leaves no dot after the pop-up closes. */
const popped=new Map<string,string>();
let pass={at:-Infinity,chosen:new Set<string>()};
const phone=()=>{try{return matchMedia('(max-width: 700px)').matches;}catch{return false;}};
/** The pop-ups allowed this pass: newest live lines whose speakers were near and drawn on the previous pass. */
function chosen(now:number){
 if(now-pass.at<120)return pass.chosen;
 const live=[...speakingNow].filter(([id,s])=>s.text&&now-s.since<popupMs(s.text)&&seen.get(id)?.eligible&&now-seen.get(id)!.at<1_000)
  .sort((a,b)=>b[1].since-a[1].since).slice(0,phone()?POPUP_MAX_PHONE:POPUP_MAX);
 pass={at:now,chosen:new Set(live.map(([id])=>id))};return pass.chosen;
}
const clip=(text:string)=>text.length>160?text.slice(0,157).trimEnd()+'…':text;

/** Paint (or clear) the pop-up and the small speaking dot in one Soul's speech bubble (`label`, the element at its
 * head). Cheap when nothing changed; one style read. `distance` is the camera distance in metres (unknown = near);
 * `shown`, whether the Soul is drawn on screen (default: `label` itself is displayed). */
export function paintSpeakingDot(label:HTMLElement,soulId:string,enabled:boolean,now=performance.now(),distance?:number,shown?:boolean){
 let dot=label.querySelector<HTMLElement>(':scope > [data-speaking-dot]'),pop=label.querySelector<HTMLElement>(':scope > [data-speech-popup]');
 const s=enabled?speakingNow.get(soulId):undefined,age=s?now-s.since:Infinity;
 const drawn=shown??(label.style.display!=='none'&&label.style.visibility!=='hidden');
 seen.set(soulId,{at:now,eligible:drawn&&(distance===undefined||!Number.isFinite(distance)||distance<=POPUP_NEAR_M)});
 if(seen.size>400)for(const [id,v] of seen)if(now-v.at>5_000)seen.delete(id);
 const showPop=!!s?.text&&age<popupMs(s.text)&&chosen(now).has(soulId),lineKey=s?(s.key??`${s.since}`):'';
 if(showPop)popped.set(soulId,lineKey);
 if(popped.size>400)for(const id of popped.keys())if(!speakingNow.has(id))popped.delete(id);
 if(showPop&&s?.text){
  if(!pop){pop=document.createElement('span');pop.dataset.speechPopup='';pop.className='dialogue-popup';pop.setAttribute('role','button');pop.tabIndex=0;
   pop.title='Open this conversation';const open=(e:Event)=>{e.stopPropagation();e.preventDefault();if(pop!.dataset.thread)requestThread(pop!.dataset.thread);};
   pop.addEventListener('click',open);pop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')open(e);});label.append(pop);}
  const key=s.key??`${s.since}`;
  if(pop.dataset.key!==key){pop.dataset.key=key;pop.dataset.thread=s.thread;pop.style.setProperty('--thread',s.colour);pop.classList.toggle('private',!!s.private);
   pop.textContent=(s.private?'🔒 ':'')+clip(s.text);pop.classList.remove('fading');pop.classList.remove('in');void pop.offsetWidth;pop.classList.add('in');}
  pop.classList.toggle('fading',age>popupMs(s.text)-POPUP_FADE_MS);
  if(pop.hidden){pop.hidden=false;}label.classList.add('dialogue-popping');label.classList.toggle('dialogue-popping-private',!!s.private);label.style.setProperty('--thread',s.colour);
 }else if(pop&&!pop.hidden){pop.hidden=true;label.classList.remove('dialogue-popping','dialogue-popping-private');}
 // The dot marks a recent speaker whose line got no pop-up (a distant one); a line that popped up leaves none.
 if(!s||age>SPEAKING_SHOW_MS||showPop||popped.get(soulId)===lineKey){if(dot&&!dot.hidden)dot.hidden=true;return;}
 if(!dot){dot=document.createElement('span');dot.dataset.speakingDot='';dot.className='dialogue-head-dot';dot.title='Speaking: click to see the conversation';
  dot.addEventListener('click',e=>{e.stopPropagation();if(dot!.dataset.thread)requestThread(dot!.dataset.thread);});label.append(dot);}
 const pulse=age<SPEAKING_PULSE_MS,state=`${s.colour}|${pulse}`;dot.dataset.thread=s.thread;
 if(dot.dataset.state!==state){dot.dataset.state=state;dot.style.setProperty('--thread',s.colour);dot.classList.toggle('pulse',pulse);}
 const opacity=String(Math.max(0,Math.min(1,(SPEAKING_SHOW_MS-age)/DOT_FADE_MS)));if(dot.style.opacity!==opacity)dot.style.opacity=opacity;
 if(dot.hidden)dot.hidden=false;
}
