/** Selection history is presentation only; current server ownership always filters it. */
export function orderedSoulIds(ids:readonly string[],recent:readonly string[]){
 const owned=new Set(ids);return [...new Set([...recent.filter(id=>owned.has(id)),...ids])];
}
export function selectedSoulIds(id:string,recent:readonly string[],owned:readonly string[]){return orderedSoulIds(owned,[id,...recent]);}
export function readSoulRecency(key:string):string[]{try{const value=JSON.parse(localStorage.getItem(key)??'[]');return Array.isArray(value)?[...new Set(value.filter((id):id is string=>typeof id==='string'))].slice(0,24):[];}catch{return [];}}
/** First day (26 Nov): the owned Souls this browser has not listed before (a newly paired one), in list order. They go
 *  to the front as if just selected, so the navbar's three avatars show a new Soul. `seen` null: the first visit, when
 *  nothing counts as new. */
export function freshSoulIds(ids:readonly string[],seen:readonly string[]|null):string[]{
 if(!seen)return [];const known=new Set(seen);return ids.filter(id=>!known.has(id));
}
export function readSeenSouls(key:string):string[]|null{try{const value=JSON.parse(localStorage.getItem(key)??'null');return Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'):null;}catch{return null;}}
export function writeSeenSouls(key:string,ids:readonly string[],seen:readonly string[]|null){try{localStorage.setItem(key,JSON.stringify([...new Set([...ids,...(seen??[])])].slice(0,96)));}catch{}}
