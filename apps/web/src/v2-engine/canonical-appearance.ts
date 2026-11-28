/** Hash-bound public appearance data from this world's normal publisher. No current-build kind alias. */
export type AppearanceRow = {kind:string;sourceEntry:{kind:string;sha256:string};sourceDef:{ref:string;sha256:string};origins:string[];entry:Record<string,unknown>;entrySHA256:string};
export type Appearance = {format:'souls-canonical-appearance/1';world:string;stream:string;sources:{facts:string;kinds:string};rows:AppearanceRow[]};
const hash=/^[a-f0-9]{64}$/,full=/^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*@1220[a-f0-9]{64}$/;
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),n=>n.toString(16).padStart(2,'0')).join('');
const fail=()=>{throw Error('canonical-appearance.invalid');};
/** The descriptor is bound by the active world's inline config, not by an entry's plain name. */
export async function loadCanonicalAppearance(value:unknown,{world,stream,origin,get=fetch}:{world:string;stream:string;origin:string;get?:typeof fetch}):Promise<Appearance|null>{
  if(value===undefined||value===null)return null;
  const d=value as {url?:unknown;sha256?:unknown;world?:unknown;stream?:unknown};
  if(typeof d.url!=='string'||typeof d.sha256!=='string'||!hash.test(d.sha256)||d.world!==world||d.stream!==stream||d.url!==`/w/${world}/v2/appearance/${d.sha256}.json`)return fail();
  const response=await get(new URL(d.url,origin).href);if(!response.ok||response.redirected)return fail();
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8*1024*1024))return fail();
  const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>8*1024*1024||await digest(bytes)!==d.sha256)return fail();
  const p=JSON.parse(new TextDecoder().decode(bytes)) as Appearance;
  if(p.format!=='souls-canonical-appearance/1'||p.world!==world||p.stream!==stream||!hash.test(p.sources?.facts)||!hash.test(p.sources?.kinds)||!Array.isArray(p.rows)||p.rows.length>1024)return fail();
  const names=new Set();
  for(const r of p.rows){
    if(!r||!full.test(r.kind)||names.has(r.kind)||r.sourceEntry?.kind!==r.kind.split('@')[0]||!hash.test(r.sourceEntry.sha256)||!hash.test(r.sourceDef?.sha256)||typeof r.sourceDef.ref!=='string'||!r.sourceDef.ref||!Array.isArray(r.origins)||!r.origins.length||new Set(r.origins).size!==r.origins.length||r.origins.some(o=>typeof o!=='string'||!o)||r.entry?.format!=='souls-entry/1'||r.entry.kind!==r.sourceEntry.kind||!hash.test(r.entrySHA256)||await digest(new TextEncoder().encode(JSON.stringify(r.entry)))!==r.entrySHA256)return fail();
    names.add(r.kind);
  }
  return p;
}
