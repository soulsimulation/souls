// The homepage's world list leaves at page entry (25 Nov, a newcomer's first visit): the list waited for the whole page's
// code to download and run before its GET left (2.6 s in on a loaded laptop, 'Loading worlds…' past 5 s on a phone).
// vite.config.ts writes worldListPrefetchScript() into index.html's head beside the snapshot prefetch; WorldList
// (main.tsx) takes that one response instead of fetching again. Same URL and fetch defaults as WorldList's own GET.
// No imports: vite.config.ts loads this file in node.

/** The window property the inline script leaves its request on. */
export const WORLD_LIST_GLOBAL = '__soulsWorldListPrefetch';

/** index.html's inline head script: on the homepage (`<base>/` with no hash, as page-route.ts names the list), GET the
 *  world list now. */
export function worldListPrefetchScript(base: string): string {
  return `(function(){try{var b=${JSON.stringify(base)},p=location.pathname;if(location.hash||(p!==b+'/'&&p!==b+'/index.html')||typeof fetch!=='function')return;`
    + `var u=b+'/__sim/worlds.json',r=fetch(u);r.catch(function(){});window[${JSON.stringify(WORLD_LIST_GLOBAL)}]={url:u,response:r};}catch(e){}})();`;
}

/** The entry GET when it was for this exact URL, at most once per page (a retry fetches afresh). */
export function takeWorldListPrefetch(url: string): Promise<Response> | null {
  const w = (typeof window === 'undefined' ? null : window) as unknown as Record<string, { url: string; response: Promise<Response> } | undefined> | null;
  const p = w?.[WORLD_LIST_GLOBAL];
  if (!p) return null;
  delete w![WORLD_LIST_GLOBAL];
  return p.url === url ? p.response : null;
}
