#!/usr/bin/env node
// A genuine local two-carrier pallet observation. The control file is a review stop before lift, never a pose input.
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {contactTools} from './oracle.mjs';
import {startOldPage} from '../arena/new-engine/old-page.mjs';
import {pairSeat} from '../arena/new-engine/seat.mjs';
import {templateFacts} from '../rack-bay/rack-bay.mjs';
const root=resolve(import.meta.dirname,'../../..'),dir=resolve(process.argv[2]??join(root,'.local/carry-contact-5127/run-1'));
mkdirSync(dir,{recursive:true});
const save=(name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=b=>createHash('sha256').update(b).digest('hex');
const {chromium}=createRequire(new URL('../../../mars/viewer/package.json',import.meta.url))('@playwright/test');
const artifactManifest=JSON.parse(readFileSync(process.env.CARRY_ARTIFACT_MANIFEST??join(root,'.local/carry-contact-5127/artifacts-private.json'),'utf8'));
const seats={},out={source:artifactManifest.source,started:new Date().toISOString(),steps:[],resources:{operator:process.pid},pageErrors:[]};
let world,browser,crew,page;
const cli=async(who,...words)=>{const at=Date.now(),answer=await seats[who].cli(...words);out.steps.push({at,who,words,answer});save('run-private.json',out);if(answer.ok!==true)throw Error(`${who} ${words.join(' ')}: ${JSON.stringify(answer)}`);return answer;};
try {
 world=await startOldPage({template:'worlds/templates/mars-camp.json',facts:templateFacts({out:dir}),dir:join(dir,'world'),history:false,marsWeb:process.env.MARS_WEB_DIR,pkg:process.env.SOULS_REPLICA_PKG,log:console.error});
 out.page=world.page;out.resources.world=world.world.pid;save('run-private.json',out);
 for(const who of ['ada','bo']){seats[who]=await pairSeat({world:world.world,dir:join(dir,'seats'),label:who,name:who==='ada'?'Ada':'Bo'});const joined=await seats[who].join();if(!joined.body)throw Error(`No body for ${who}`);out[who]={soul:seats[who].soul,native:joined.body};}
 const q=await cli('ada','query',JSON.stringify([{find:'pallet-crates-1'}]));out.loadCandidates=q;
 await Promise.all([cli('ada','carry','grip','pallet-crates-1','front'),cli('bo','carry','grip','pallet-crates-1','back')]);
 const offered=await cli('ada','carry','offer',out.bo.native);crew=offered.crew;if(!crew)throw Error('No offered crew');await cli('bo','carry','accept',crew);
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();
 const loaded={};page.on('response',async response=>{try{const u=new URL(response.url());if(u.pathname.endsWith('.js'))loaded[u.pathname]=sha(await response.body());}catch{}});page.on('pageerror',e=>out.pageErrors.push(String(e)));
 await page.goto(`${world.page}?post=0&hour=12:00`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__soulsEntity?.gameFrame().souls.length>=2&&!document.querySelector('.viewer-arrival')&&document.querySelector('.viewer-history[data-viewer-ready="true"]'),null,{timeout:120000});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 // Runtime bindings are inspected before installing/activating the oracle; none are guessed from nearby positions.
 const scene=await page.evaluate(()=>{const w=window.__soulsEntity;return{souls:w.gameFrame().souls,entities:Object.entries(w.gameFrame().entities).map(([id,e])=>({id,def:e.def,pos:e.p})),drawn:[...w.layer.drawn].map(([id,d])=>({id,inst:d.inst,shown:d.shown,name:d.obj.name}))};});
 save('scene-binding-private.json',scene);save('run-private.json',out);save('loaded-js-private.json',loaded);
 await page.screenshot({path:join(dir,'setup-original.png')});save('ready-private.json',{page:world.page,dir,crew,resources:out.resources,buttons:await page.getByRole('button').allTextContents()});console.log(`SETUP_READY ${dir}`);
 // The coordinator may inspect and use this browser's real controls before authorizing lift.
 const deadline=Date.now()+10*60_000;
 // Button/key commands use Playwright's normal input. The reviewer requires a side-on full-body view, not the initial broadcast view.
 let reviewedCommand = null;
 while(!existsSync(join(dir,'go'))){
  if(Date.now()>deadline)throw Error('Review stop expired');
  const file=join(dir,'review-private.json');
  if(existsSync(file)){
   const c=JSON.parse(readFileSync(file,'utf8'));
   if(c.id!==reviewedCommand){
    reviewedCommand=c.id;
    if(c.type==='key'&&typeof c.key==='string'&&Number.isFinite(c.ms)&&c.ms>=0&&c.ms<=3000){await page.keyboard.down(c.key);await sleep(c.ms);await page.keyboard.up(c.key);}
    else if(c.type==='button'&&typeof c.name==='string')await page.getByRole('button',{name:c.name,exact:true}).click();
    else if(c.type!=='shot')throw Error('Unknown real-input review command');
    await page.screenshot({path:join(dir,`setup-review-${String(c.id).replace(/[^a-zA-Z0-9-]/g,'')}.png`)});
   }
  }
  await sleep(100);
 }
 // Binding file is produced from the recorded actual query and exact page mapping, and independently reviewed.
 const binding=JSON.parse(readFileSync(join(dir,'binding-private.json'),'utf8'));
 const entry=JSON.parse(readFileSync(binding.entryFile,'utf8'));
 if(sha(readFileSync(binding.entryFile))!==binding.load.entrySha256)throw Error('Entry bytes changed');
 const kitURL=Object.keys(loaded).find(p=>/\/people-kit-[^/]+\.js$/.test(p));if(!kitURL)throw Error('Production people kit response not observed');
 await page.evaluate(contactTools,{kitURL,binding,entry,source:out.source});
 await cli('ada','carry','lift',crew,'pallet-crates-1');
 await sleep(1500);await page.evaluate(()=>{window.__carryContactObserver.active=true;});await sleep(3000);
 await page.screenshot({path:join(dir,'lift-original.png')});out.measuredCanvas={setup:'setup-original.png',lift:'lift-original.png',samePage:true};out.observer=await page.evaluate(()=>{const o=window.__carryContactObserver;o.stop();const{stop,...data}=o;return data;});save('observer-private.json',out.observer);save('loaded-js-private.json',loaded);
 out.after=await cli('ada','query',JSON.stringify([{find:'pallet-crates-1'}]));console.log(`MEASURED ${JSON.stringify(out.observer.counts)}`);
} catch(error){out.error=String(error.stack??error);console.error(out.error);process.exitCode=1;}
finally {
 if(crew){for(const words of [['set-down',crew],['leave',crew]])try{await cli('ada','carry',...words);}catch(e){out.cleanupErrors??=[];out.cleanupErrors.push(String(e));}try{await cli('bo','carry','leave',crew);}catch(e){out.cleanupErrors??=[];out.cleanupErrors.push(String(e));}}
 await browser?.close();for(const [who,seat]of Object.entries(seats))out[`${who}Stopped`]=await seat.stop();await world?.stop();out.finished=new Date().toISOString();out.stopped=true;save('run-private.json',out);
}
