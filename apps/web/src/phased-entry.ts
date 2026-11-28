// P7b lever E1 (team/lanes/t4-p7.md "P7b design"): index.html loads a world page in two phases where that helps. On a
// phone's link every byte waits for the bytes before it, and the world could not start building until the last of ~1 MB
// had arrived (all of React, the Shell, the UI). Phase one is the early entry (early-entry.ts) with only the chunks the
// world's entity layer needs, beside the snapshot the head script already asked for; the layer then builds the terrain
// and the near ring while phase two (main.tsx, React, the Shell, the rest of the UI, the socket) downloads. Phase two
// starts when the snapshot is in (early-entry.ts calls window.__soulsPhase2), after at most PHASE2_FALLBACK_MS, or at once
// if the early entry fails to load; its socket opens after at most SOCKET_FALLBACK_MS (PF2). P7d: `__soulsPhase2(true)` starts only its downloads and the socket; the main entry
// itself runs at the next call (early-entry.ts: once the early renderer's poster is up), so it never competes with it. Pages that are not two-phase (the head script's phasedEntryWanted: desktops, old
// worlds, pictures, ?phased=0) load both at once, main first, as before.
// #4986: where the launcher says this build's files are on the asset CDN (app-cdn.ts), the loader asks for both phases
// there instead of the origin, by file name; everything those files load follows them (vite.config.ts builtUrl). An entry
// that does not load from the CDN (unreachable, blocked, a file missing) reloads the page once with `?appcdn=0`, from the origin.
// A browser refuses to start a worker from another origin's file, so on such a page the loader also wraps `Worker`: a
// module worker asked for at the CDN's origin is started from a same-origin blob module that imports that file by name
// from the CDN folder (its own imports then come from the CDN too). Any other worker is started as asked. That wrapper
// and the choice live here, in index.html, so the page's chunks carry none of it.
// #4986 review: the same once-only reload covers a CDN that hangs (no file of it has arrived APP_CDN_HANG_MS after the
// loader asked, and the early entry has not loaded) and a failure after the entry has loaded: a lazy chunk or style
// (Vite's `vite:preloadError`) or a worker started from the CDN that does not load. `?appcdn=0` turns all of it off, so
// it can never loop. Data files fetched by the app's own code keep their own handling.
// No imports but one as plain as this file: vite.config.ts loads this file in node.
import { appCdn } from './app-cdn.ts';

/** The window function that starts phase two (idempotent; `(true)`: its downloads, not yet its entry; `('fill')`: its
 *  downloads, its entry's download and the socket; `()`: everything, the entry run). */
export const PHASE2_GLOBAL = '__soulsPhase2';
/** Phase two starts by itself this long after phase one, whatever happened to the early entry. PF2: was 15 s. */
export const PHASE2_FALLBACK_MS = 8_000;
/** PF2 (2026-10-20): the socket opens by itself this long after phase one when the snapshot has not answered by then.
 *  Before, a late snapshot held the socket too, so its join started only after the snapshot; on live the snapshot answers
 *  in ~0.3-0.6 s, so this only acts when it is late. t4-phone (2026-10-21): when the snapshot has answered, the socket waits
 *  for the early renderer's fill (below) or phase two's entry: its join (~165 KB on the wire) no longer shares a phone's
 *  link with the poster's own bytes (it opened here at 2.5 s on every phone page and came in before the poster). */
export const SOCKET_FALLBACK_MS = 2_500;
// t4-phone3 (2026-10-22): that 2.5 s now counts from the early entry's load, not the page's start: on a phone's link the
// snapshot's answer waits behind phase one's ~400 KB of code, so at 2.5 s it had "not answered" on every phone page
// and the join (~165 KB) shared the link with the poster's scripts and phase two's entry. And the socket opens once
// phase two's entry has downloaded (not with its download): the join no longer delays the entry, so the card (which
// waits for the entry, not for the join) comes ~1 s sooner. Phase two's entry downloads once its other downloads are in
// and the poster's nearest models are in (the arrival gate), not at the early renderer's fill: on Eden 2026 the gate is
// clear seconds before the fill (the phone is building the world, the link idle). Without the gate check it took the link
// from Mars College's near models (poster +23%).
/** t4-phone: `__soulsPhase2(FILL)`: the poster's bytes are in (the early renderer's nearest models too), so phase two's entry
 *  is fetched (not run) and the socket opens while the phone links and draws the poster; the entry runs at the next plain
 *  call, as before. */
export const PHASE2_FILL = 'fill';
/** #4986 review: a CDN that has delivered no file at all this long after the loader asked for the first is taken as
 *  hung, and the page reloads once from the origin. 8 s: the first phase's smallest files are a few KB, which even a 2G
 *  link (~50 kbit/s) brings in well under it after a new connection's handshakes; a hang otherwise lasts forever. It
 *  times arrival of any file, not the whole download, so a slow link is never sent to download it all again. */
export const APP_CDN_HANG_MS = 8_000;

export type Phase = { entry: string; preloads: readonly string[] };

/** Call the page's phase-two function (the loader below defines it; the loader's own fallbacks run it if this fails). */
export function callPhase2(mode?: true | typeof PHASE2_FILL): void {
  try { (window as unknown as Record<string, ((mode?: true | string) => void) | undefined>)[PHASE2_GLOBAL]?.(mode); } catch { /* the loader's fallbacks */ }
}

/** The inline loader that replaces Vite's module script and modulepreload tags. Reads window.__soulsPhased (snapshot-prefetch.ts
 *  head script) and opens the deferred entry socket (window.__soulsOpenSocket) with phase two. */
export function phasedLoaderScript(early: Phase, main: Phase): string {
  return `(function(){var d=document,W=window,E=${JSON.stringify(early)},M=${JSON.stringify(main)},done=false,pre=false,sock=false,`
    // #4986: C is the CDN directory ('' = the origin); at(u) is u's file there; back() reloads once from the origin
    + `C=(function(){try{return (${appCdn.toString()})(W.__simConfig,location.search||'');}catch(e){return '';}})(),at=function(u){return C?C+u.slice(u.lastIndexOf('/')+1):u;},`
    + `gone=false,back=function(){if(gone)return;gone=true;try{location.replace(location.pathname+(location.search?location.search+'&':'?')+'appcdn=0'+location.hash);}catch(e){}},`
    // a worker from the CDN: a same-origin blob that imports it (freed once the worker has read it); one that does not
    // load (a plain error event; an error inside a running worker carries a message) takes the same reload
    + `NW=C&&W.Worker,SW=NW&&function(u,o){var b='';try{var a=new URL(String(u),location.href);if(o&&o.type==='module'&&a.origin===new URL(C).origin)u=b=URL.createObjectURL(new Blob(['import '+JSON.stringify(C+a.pathname.slice(a.pathname.lastIndexOf('/')+1))],{type:'text/javascript'}));}catch(e){}`
    + `var w=new NW(u,o);if(b){try{w.addEventListener('error',function(e){if(!e.message)back();});setTimeout(function(){URL.revokeObjectURL(b);},6e4);}catch(e){}}return w;},`
    + `add=function(u,entry){var l=d.createElement(entry?'script':'link');if(entry){l.type='module';l.src=at(u);if(C)l.addEventListener('error',back);}else{l.rel='modulepreload';l.href=at(u);}l.crossOrigin='';d.head.appendChild(l);return l;},`
    + `so=function(){if(!sock){sock=true;try{var o=W.__soulsOpenSocket;if(typeof o==='function')o();}catch(e){}}},`
    // t4-phone3: the entry's download (fe) and its end (ml): the socket opens once it is in, its join after it on the link
    + `si=false,fe=false,ml=false,`
    // t4-phone3: B' = phase two's other downloads in and the poster's nearest models in (window.__arrivalGate): fill
    + `near=function(){var g=W.__arrivalGate;if(g&&g.pending()){var off=g.subscribe(function(){if(!g.pending()){off();fill();}});}else fill();},`
    + `fill=function(){if(!done&&!fe){fe=true;var l=add(M.entry);l.onload=l.onerror=function(){ml=true;so();};}},`
    + `two=function(hold){if(!pre){pre=true;var left=M.preloads.length,got=function(){if(--left===0&&hold===true)near();};M.preloads.forEach(function(u){var l=add(u);l.onload=l.onerror=got;});if(!left&&hold===true)near();}`
    + `if(hold===${JSON.stringify(PHASE2_FILL)})fill();if(hold!==true&&hold!==${JSON.stringify(PHASE2_FILL)}&&!done){done=true;var e=add(M.entry,true);if(!fe||ml)so();else e.onload=e.onerror=so;}};`
    + `if(SW){SW.prototype=NW.prototype;W.Worker=SW;}`
    + `W[${JSON.stringify(PHASE2_GLOBAL)}]=two;var ph=W.__soulsPhased===true;if(!ph)two();`
    + `try{W.__soulsSnapshotPrefetch.response.then(function(){si=true;},function(){});}catch(e){}`
    + `E.preloads.forEach(function(u){add(u);});var ee=add(E.entry,true);ee.onerror=two;if(ph){ee.onload=function(){setTimeout(function(){if(!si)so();},${SOCKET_FALLBACK_MS});};setTimeout(two,${PHASE2_FALLBACK_MS});}`
    // #4986 review: a hung CDN (nothing of it arrived, the early entry not in) and a lazy chunk or style that fails later
    + `if(C){var eo=false;ee.addEventListener('load',function(){eo=true;});setTimeout(function(){if(eo)return;try{var es=performance.getEntriesByType('resource');for(var i=0;i<es.length;i++)if(es[i].name.indexOf(C)===0)return;}catch(e){return;}back();},${APP_CDN_HANG_MS});`
    + `W.addEventListener('vite:preloadError',back);}})();`;
}

const MODULE_SCRIPT = /[ \t]*<script type="module" crossorigin src="([^"]+)"><\/script>\n?/g;
const MODULE_PRELOAD = /[ \t]*<link rel="modulepreload" crossorigin href="([^"]+)">\n?/g;

/** Vite's built index.html with its module script and modulepreload tags replaced by the two-phase loader. `mainFile` /
 *  `earlyFile` are the two entry chunks' file names, `earlyImports` every chunk the early entry imports (statically, at
 *  any depth). Phase one preloads those; phase two preloads what main needs beyond them. */
export function rewritePhasedHtml(html: string, mainFile: string, earlyFile: string, earlyImports: readonly string[]): string {
  const scripts = [...html.matchAll(MODULE_SCRIPT)].map((m) => m[1]);
  if (scripts.length !== 1 || !scripts[0].endsWith(mainFile)) throw Error(`index.html: expected one module script for ${mainFile}, found ${scripts.join(', ') || 'none'}`);
  const prefix = scripts[0].slice(0, -mainFile.length);
  const early = new Set([earlyFile, ...earlyImports].map((f) => prefix + f));
  const main: Phase = { entry: scripts[0], preloads: [...html.matchAll(MODULE_PRELOAD)].map((m) => m[1]).filter((u) => !early.has(u)) };
  const loader = `    <script>${phasedLoaderScript({ entry: prefix + earlyFile, preloads: earlyImports.map((f) => prefix + f) }, main)}</script>\n`;
  return html.replace(MODULE_PRELOAD, '').replace(MODULE_SCRIPT, () => loader);
}
