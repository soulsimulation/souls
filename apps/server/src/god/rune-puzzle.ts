import type {WorldModel} from '@souls/world-compiler';

/** Current local facts only; ordinary declarative actions continue to own all mutations. */
export function runePuzzleFacts(model:WorldModel,id:string):Record<string,unknown>|null{
 const e=model.entities.get(id),def=e&&model.resolvedDef(e.def);
 if(!e||def?.name!=='core-rune-puzzle'||def.version!==1)return null;
 const fields=['northwest','north','northeast','southwest','south','southeast','solved','wins','rules'];
 return Object.fromEntries(fields.map(k=>[k,e.state?.[k]??(def.state[k] as {default?:unknown})?.default]));
}
