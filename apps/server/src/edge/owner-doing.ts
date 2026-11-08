// #1313: what the owner's card says between "Picked up" and the result. Only world records: the Soul's receipts, its
// refusals, its server plans, an act linked to the message, and the message's own state. With no record it says nothing.
// The act shown is the newest one begun since the owner's newest message was picked up, so an older act never reads as
// the answer to a newer message. Owner only: it rides on the owner's inbox view, never on the agent's or a public one.
import type {DatabaseSync} from 'node:sqlite';
import type {EdgeReceipt} from './contract.ts';
import {describeBase, plainReason} from './owner-day.ts';

export type DoingPhase = 'running' | 'done' | 'failed' | 'refused' | 'cut' | 'paused';
export type OwnerDoing = {phase: 'thinking'; since: number}
  | {phase: DoingPhase; text: string; reason?: string; step?: {n: number; of: number}};
/** The message as the owner view has it (InboxMessage). */
export type DoingMessage = {id: string; state: 'sent' | 'delivered' | 'acknowledged'; deliveredAt?: number; result?: string};
export type DoingSources = {
  db: DatabaseSync; worldId: string;
  receipt(soulId: string, id: string): EdgeReceipt | null;
  nameOf(id: string): string | null;
  /** An act linked to this message that runs now (a repeat answers with a receipt begun before the pickup). */
  linked?(soulId: string, message: string): EdgeReceipt | null;
};
type PlanStep = {do?: string | Record<string, unknown>; say?: string; label?: string; until?: unknown;
  state: {status: string; receipt?: string; capability?: string; code?: string; reason?: string}};
type PlanBody = {id: string; state: string; current: number; steps: PlanStep[]; createdAt: number; updatedAt: number};

const TEXT_MAX = 120;
const clip = (s: string) => s.length > TEXT_MAX ? s.slice(0, TEXT_MAX - 1) + '…' : s;
const PLAN_REF = /^pl:([^:]+):(\d+):/;

export function receiptPhase(phase: EdgeReceipt['phase']): DoingPhase {
  return phase === 'completed' ? 'done' : phase === 'failed' ? 'failed' : phase === 'replaced' ? 'cut' : 'running';
}

function planBody(src: DoingSources, id: string): PlanBody | null {
  try {
    const r = src.db.prepare('SELECT body FROM edge_plans_v1 WHERE world_id=? AND plan_id=?').get(src.worldId, id) as {body: string} | undefined;
    return r ? JSON.parse(r.body) as PlanBody : null;
  } catch {return null;}
}
function stepText(src: DoingSources, s: PlanStep): string {
  if (s.label) return s.label;   // the plan's own words for the step first, as a receipt from the plan says them
  if (s.state.capability) return describeBase(s.state.capability, src.nameOf);
  if (s.say !== undefined) return `say "${s.say}"`;
  if (typeof s.do === 'string') return describeBase(s.do, src.nameOf);
  const cap = s.do && typeof s.do.capability === 'string' ? s.do.capability : null;
  return cap ? describeBase(cap, src.nameOf) : s.do ? `${String(s.do.verb ?? 'do')}${typeof s.do.target === 'string' ? ` ${s.do.target}` : ''}` : 'wait';
}
function fromReceipt(src: DoingSources, soulId: string, id: string, ref: string | null): OwnerDoing | null {
  const r = src.receipt(soulId, id); if (!r) return null;
  const phase = receiptPhase(r.phase), m = ref ? PLAN_REF.exec(ref) : null, plan = m ? planBody(src, m[1]!) : null;
  const n = m ? Number(m[2]) : -1, step = plan && plan.steps[n] ? {n: n + 1, of: plan.steps.length} : undefined;
  const text = plan?.steps[n]?.label ?? describeBase(r.capability, src.nameOf);
  return {phase, text: clip(text),
    ...(phase === 'failed' && (r.code || r.reason) ? {reason: plainReason(r.code, r.reason)} : {}), ...(step ? {step} : {})};
}
function fromPlan(src: DoingSources, p: PlanBody): OwnerDoing | null {
  const s = p.steps[p.current]; if (!s) return null;
  const st = s.state.status, refusedOrFailed: DoingPhase = s.state.receipt ? 'failed' : 'refused';
  const phase: DoingPhase = st === 'done' ? 'done' : st === 'failed' ? refusedOrFailed : st === 'skipped' ? 'cut'
    : p.state === 'running' ? 'running' : p.state === 'paused' ? 'paused' : p.state === 'done' ? 'done' : 'cut';
  return {phase, text: clip(stepText(src, s)), step: {n: p.current + 1, of: p.steps.length},
    ...((phase === 'failed' || phase === 'refused') && (s.state.code || s.state.reason) ? {reason: plainReason(s.state.code, s.state.reason)} : {})};
}

/** The act line for the owner's newest message, the thinking state, or null (nothing on record). `away`: the agent's
 *  presence is away (no thinking claim then). */
export function ownerDoing(src: DoingSources, soulId: string, msg: DoingMessage | null, away: boolean): OwnerDoing | null {
  if (!msg || msg.deliveredAt === undefined) return null;
  const since = msg.deliveredAt, w = src.worldId;
  let plan: {plan_id: string; body: string; created_at: number; updated_at: number} | undefined;
  try {plan = src.db.prepare('SELECT plan_id,body,created_at,updated_at FROM edge_plans_v1 WHERE world_id=? AND soul_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 1').get(w, soulId, since) as typeof plan;} catch {/* no plans here */}
  // the plan's own acts belong to its frame; any other act begun after it was made is newer than the plan
  const rec = src.db.prepare(`SELECT receipt_id,client_ref,created_at FROM edge_receipts_v1 WHERE world_id=? AND soul_id=? AND created_at>=?${plan ? ' AND (client_ref IS NULL OR client_ref NOT LIKE ?)' : ''} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(...[w, soulId, since, ...(plan ? [`pl:${plan.plan_id}:%`] : [])]) as {receipt_id: string; client_ref: string | null; created_at: number} | undefined;
  let ref: {at: number; capability: string; code: string; reason: string | null} | undefined;
  try {ref = src.db.prepare('SELECT at,capability,code,reason FROM edge_refusals_v1 WHERE world_id=? AND soul_id=? AND at>=? ORDER BY at DESC LIMIT 1').get(w, soulId, since) as typeof ref;} catch {/* an older table */}
  // a plan's own refused step writes a refusal too, before the plan saves it: one at or before its last save is the plan's
  if (plan && (!rec || rec.created_at < plan.created_at) && (!ref || ref.at <= plan.updated_at)) {
    try {const d = fromPlan(src, JSON.parse(plan.body) as PlanBody); if (d) return d;} catch {/* an unreadable plan shows nothing of its own */}
  }
  if (ref && (!rec || ref.at > rec.created_at)) return {phase: 'refused', text: clip(describeBase(ref.capability, src.nameOf)), reason: plainReason(ref.code, ref.reason)};
  if (rec) {const d = fromReceipt(src, soulId, rec.receipt_id, rec.client_ref); if (d) return d;}
  const linked = src.linked?.(soulId, msg.id);
  if (linked) {const d = fromReceipt(src, soulId, linked.id, null); if (d) return d;}
  if (msg.state === 'delivered' && msg.result === undefined && !away) return {phase: 'thinking', since};
  return null;
}
