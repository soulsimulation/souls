// First-day round 2: a reload kept the Soul card's thread (the aloud lines a tab showed come back as replay), and a
// line that popped up over a head leaves no dot behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDialogueStore,ingestDialogue,keepDialogue,keptDialogue,KEEP_MS,type DialogueEdgeMessage} from './dialogue-threads.ts';

const store=new Map<string,string>();
(globalThis as unknown as {sessionStorage:Pick<Storage,'getItem'|'setItem'>}).sessionStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>{store.set(k,v);}};
const line=(id:string,at:number,text:string):DialogueEdgeMessage=>({type:'edge',kind:'speech',id,tick:at/50,at,from:{soulId:'s_w',name:'Wren'},text,channel:{kind:'earshot',radius:8},heardBy:[]});

test('the aloud lines a tab showed come back after a reload, as replay, and fold once with the stream\'s own', ()=>{
  const now=1_000_000_000;
  const turn={type:'edge',kind:'conversation.turn',conversation:'c1',turn:{seq:1,from:{soulId:'s_w',name:'Wren'},text:'just us',at:now},at:now} as DialogueEdgeMessage;
  const kept=keepDialogue('w1',[],[line('v2:s_w:10',now-KEEP_MS-1,'too old'),line('v2:s_w:20',now-1000,'Hello! I am Wren.'),turn],now);
  assert.deepEqual(kept.map(m=>m.text),['Hello! I am Wren.'],'aloud lines within the window only, never private turns');
  const back=keptDialogue('w1',now);
  assert.equal(back.length,1);assert.equal(back[0].replay,true);
  assert.deepEqual(keptDialogue('w2',now),[],'per world');
  const s=createDialogueStore();ingestDialogue(s,back,[],now);
  // the reloaded stream says the same line again (same speaker and tick): one line, still a replay
  ingestDialogue(s,[line('v2:s_w:20',now+5,'Hello! I am Wren.')],[],now);
  const lines=[...s.threads.values()].flatMap(t=>t.lines);
  assert.deepEqual(lines.map(l=>[l.text,l.replay]),[['Hello! I am Wren.',true]]);
});

test('storage that throws leaves the thread empty, never an error', ()=>{
  const was=(globalThis as unknown as {sessionStorage:unknown}).sessionStorage;
  (globalThis as unknown as {sessionStorage:unknown}).sessionStorage={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
  try{assert.deepEqual(keptDialogue('w1'),[]);assert.equal(keepDialogue('w1',[],[line('v2:a:1',Date.now(),'hi')]).length,1);}
  finally{(globalThis as unknown as {sessionStorage:unknown}).sessionStorage=was;}
});
