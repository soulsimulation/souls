// The carry readers that start from bytes (a stream part's file, a history bundle), for the stream worker and the
// page's thread, which decode with cborg. The records themselves, read from decoded values, are carry-fields.ts.
import {decode} from 'cborg';
import {unpack} from './sound-record.ts';
import {bundleCarryChanges,bundleMotion,carryChanges,type CarryChange} from './carry-fields.ts';
export * from './carry-fields.ts';
const map=(v:unknown):Map<number,unknown>=>{if(!(v instanceof Map))throw Error('carry-record: map required');return v;};
export function carryChangesInPart(bytes:Uint8Array):CarryChange[]{const s=map(decode(bytes,{useMaps:true})),p=map(decode(unpack(s.get(6)as Uint8Array),{useMaps:true}));return carryChanges((p.get(2)as unknown[])??[]);}
export const carryChangesInBundle=(bytes:Uint8Array):CarryChange[]=>bundleCarryChanges(decode(bytes,{useMaps:true}));
/** Full quaternion recovery from the SAME already-validated bundle; historyAt's legacy prefix stays unchanged. */
export const historyMotion=(bytes:Uint8Array)=>bundleMotion(decode(bytes,{useMaps:true}));
