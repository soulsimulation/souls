import {z} from 'zod';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
/** #1323: a world whose history began without the repair rules (`souls-repair/1`, #1150) runs them from this logged fact on.
 *  One way: a reader without the repair rules can't replay past it. */
export const soulsRepairAdoptionV1Schema=z.object({
  contract:z.literal('souls-repair-adoption/1'),tick:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  fromRulesVersion:z.string().min(1),toRulesVersion:z.string().min(1),fromStateHash:digest,
}).strict();
export type SoulsRepairAdoptionV1=z.infer<typeof soulsRepairAdoptionV1Schema>;
export type SoulsRepairAdoptionAdmissionV1={ok:true;transition:SoulsRepairAdoptionV1}|{ok:false;diagnostic:{code:string;message:string}};
