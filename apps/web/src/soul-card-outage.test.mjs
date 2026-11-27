// #1330: the owner's Soul card while a new-engine world (or the page's connection to it) is down: the status line says
// "World unavailable" instead of the last link and activity, nothing blames the agent, and the message box stays with
// its draft, its Send disabled, with one line saying why. Static renders, as soul-card-states.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const dir=await mkdtemp(join(tmpdir(),'souls-soul-card-outage-'));
globalThis.location={origin:'https://sim.eden.art',pathname:'/worlds/w/eden-2026/',search:'',hash:''};
globalThis.sessionStorage={getItem:()=>null};
const outfile=join(dir,'cards.cjs');
await build({stdin:{contents:`export {SoulCardView} from './SoulCard.tsx';export {AgentMessageBoxView,UNAVAILABLE_LINE} from './AgentMessageBox.tsx';export {CARD_FIXTURES,FIXTURE_CLOCK} from './soul-card-fixtures.ts';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`,resolveDir:new URL('.',import.meta.url).pathname,loader:'tsx'},outfile,bundle:true,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty','.json':'json'},logLevel:'silent'});
const M=require(outfile),{SoulCardView,AgentMessageBoxView,UNAVAILABLE_LINE,CARD_FIXTURES:F,createElement:h,renderToStaticMarkup:render}=M;
test.after(()=>rm(dir,{recursive:true,force:true}));
const text=html=>html.replace(/<[^>]+>/g,'').replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&');
const send=async()=>{};

test('unavailable: "World unavailable" in place of Connected and the stale activity; the box stays, Send off, the line says why',()=>{
 const was=F['connected'],inbox={...was.inbox,unavailable:true};
 const html=render(h(SoulCardView,{...was,send,inbox,mailbox:true,unavailable:true,doing:'Walking',place:'the pond'})),t=text(html);
 assert.match(html,/data-soul-state="unavailable"/);
 assert.match(html,/data-status="unavailable"/);assert.match(t,/World unavailable/);
 assert.doesNotMatch(t,/Connected|Walking|at the pond|Awake/,'no stale link or activity');
 assert.ok(html.includes('data-agent-message="soul"'),'the message box stays');
 assert.match(html,/<button type="submit" disabled="">Send<\/button>/,'Send is off');
 assert.match(html,/data-world-unavailable="1"/);assert.ok(t.includes(UNAVAILABLE_LINE));
});
test('unavailable while the last link said Disconnected: no Reconnect box blaming the agent',()=>{
 const was=F['disconnected-zombie'];
 const html=render(h(SoulCardView,{...was,send,inbox:{connected:false,lastSeenAt:null,latest:null,unavailable:true},mailbox:true,unavailable:true})),t=text(html);
 assert.doesNotMatch(html,/data-reconnect="1"/);assert.doesNotMatch(t,/stopped listening|Reconnect|Disconnected/);
 assert.match(t,/World unavailable/);assert.ok(html.includes('data-agent-message="soul"'));
});
test('the box keeps a draft typed during the outage (its input stays editable), and sends again once back',()=>{
 const down=render(h(AgentMessageBoxView,{kind:'soul',inbox:{connected:false,lastSeenAt:null,latest:null,unavailable:true},text:'meet me by the well',onText(){},onSend(){}}));
 assert.match(down,/value="meet me by the well"/);assert.doesNotMatch(down,/<input[^>]*disabled/);assert.match(down,/<button type="submit" disabled="">/);
 const back=render(h(AgentMessageBoxView,{kind:'soul',inbox:{connected:true,lastSeenAt:null,latest:null},text:'meet me by the well',onText(){},onSend(){}}));
 assert.match(back,/<button type="submit">Send<\/button>/);assert.doesNotMatch(back,/data-world-unavailable/);
});
test('not unavailable: the card is as before (Connected, the activity)',()=>{
 const was=F['connected'],t=text(render(h(SoulCardView,{...was,send,mailbox:true,doing:'Walking',place:'the pond'})));
 assert.match(t,/Connected/);assert.match(t,/Walking at the pond/);assert.doesNotMatch(t,/World unavailable/);
});
