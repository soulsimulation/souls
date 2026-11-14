import {useEffect,useState} from 'react';
/** #2280: what someone is typing outlives a reconnect, a remount and a page reload. One draft per input, in this tab's
 * sessionStorage (never sent anywhere); sending clears it. Storage that is blocked or full keeps the plain in-memory box. */
const PREFIX='sim.draft.',MAX=4000;
export function readDraft(key:string,store:Pick<Storage,'getItem'>|undefined=globalThis.sessionStorage):string{
 try{return store?.getItem(PREFIX+key)??'';}catch{return '';}
}
export function writeDraft(key:string,text:string,store:Pick<Storage,'setItem'|'removeItem'>|undefined=globalThis.sessionStorage){
 try{if(text)store?.setItem(PREFIX+key,text.slice(0,MAX));else store?.removeItem(PREFIX+key);}catch{/* the box still works */}
}
/** useState for a text box, kept as the draft under `key` (another key, another draft). */
export function useDraft(key:string):[string,(text:string)=>void]{
 const [state,setState]=useState(()=>({key,text:readDraft(key)}));
 useEffect(()=>{if(state.key!==key)setState({key,text:readDraft(key)});},[key,state.key]);
 const text=state.key===key?state.text:readDraft(key);
 return [text,(next:string)=>{writeDraft(key,next);setState({key,text:next});}];
}
