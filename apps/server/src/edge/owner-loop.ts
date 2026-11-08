// D3 (playtest 2026-10-25, ROOT-CAUSES §C D3): only the agent turned a receipt into its owner's result, and it rarely did
// in time (29 of 75 card messages had a result before the cutoff). An act may now name the owner message it serves
// (`for`, the CLI's `act --for <id>`, by default the newest message it acknowledged); when that act's receipt ends the
// world writes the message's result line itself from the receipt, unless the agent already wrote one. The agent's own
// `result` still replaces the world's line. Links are kept in memory (a restart drops them: the agent can still result).
// D3c (laptop trio-r1 rook-003: "have a little rest, then come back to the balloon" closed Done by a wave): a link the
// CLI made by default (`implicit`, the agent did not choose it) closes the message only with an act of its last step
// (messageSteps); any other act's end posts a progress line ("now: …; not resting yet") and leaves the card open, and the
// act's answer says `open` so the CLI's default serves the next act too. An explicit `for` closes as before.
// D3d (fix-d3c-c trio-r1 rook-003: a walk to a bench closed "…then come back to the balloon" as "walk completed"): in a
// message of several steps the last step's act must also reach the step's target when it names one (the balloon, the
// pavilion, Tam): the receipt's own target is it or a place inside it, or the body ended inside the named place or near
// the named thing or Soul. A last step whose target the world cannot resolve is never closed by default: progress only,
// the agent's `result` closes it. One-step messages and explicit links are unchanged.
// #1295: the world never records a message as finished while an act linked to it runs. A close then (`result`, a Soul's
// ack with `outcome`) is refused and writes nothing (`running`); an act that ends while another linked to the same
// message runs posts progress, and the last one to end closes it. Every message still reaches a close: a linked act
// replaced with nothing else serving its message closes it `failed` (after GONE_TICKS, so a replacing act linked to the
// message can take it); one still running after HOLD_TICKS has it closed `failed` (never done), and its real end
// replaces that line. An open-ended hold the body has reached (a sit or lie with no `seconds`) or a follow has done what
// it was asked and holds nothing. Links are kept durably beside the receipts (`ownerLinkStore`), not in the world's log:
// a restart keeps the guard and the close, and a link whose receipt is gone (a rewind or restore) is dropped.
import type {EdgeReceipt, EdgeSoul} from './contract.ts';
import type {Db} from '../db.ts';
import {messageSteps, type MessageStep, type StepTarget} from './ledger/vocabulary.ts';

export type OwnerLoopInbox = {
  hasMessage(s: {scope: string; owner: string}, id: string): boolean;
  /** `open`: write only into a message with no result yet (#1295: the world's own replaced and overlong lines). */
  serverResult(s: {scope: string; owner: string}, id: string, text: string, outcome: 'done' | 'failed', open?: boolean): boolean;
  messageText?(s: {scope: string; owner: string}, id: string): string | null;
  serverProgress?(s: {scope: string; owner: string}, id: string, text: string): boolean;
  /** #1295: set by the loop; the inbox refuses a close while it answers a receipt. */
  closeHold?: ((s: {scope: string; owner: string}, id: string) => {receipt: string; capability: string} | null) | null;
};
/** D3d: what the world knows to judge a step's target (the ledger): the resolver, what an offered capability points at
 *  (its target's id), a place's id with its ancestors (null: not a place), and where a thing or Soul stands now. */
export type OwnerLoopWorld = {
  stepTarget(soul: EdgeSoul, words: string[]): StepTarget | null;
  actTarget(soul: EdgeSoul, capability: string): string | null;
  placePath(id: string): string[] | null;
  posOf(id: string): [number, number] | null;
  /** #1295: whether this open act is an open-ended hold its body has reached, or a follow (the ledger's `holding`). */
  holding?(soulId: string, receiptId: string): boolean;
  /** #1295: a light read of a receipt for the sweep and the guard (no body or outcome facts); else `read` is used. */
  brief?(soulId: string, receiptId: string): {id: string; capability: string; phase: string; acceptedTick: number; endedTick: number | null} | null;
};
/** #1295: where links are kept across a restart (`ownerLinkStore`); without one they live in memory only. */
export type OwnerLinkStore = {load(): [string, string][]; save(receipt: string, soulId: string, link: string): void; drop(receipt: string): void};
export function ownerLinkStore(db: Db, worldId: string): OwnerLinkStore {
  db.db.exec('CREATE TABLE IF NOT EXISTS edge_owner_links_v1 (world_id TEXT NOT NULL, receipt_id TEXT NOT NULL, soul_id TEXT NOT NULL, link TEXT NOT NULL, PRIMARY KEY (world_id, receipt_id))');
  const save = db.db.prepare('INSERT INTO edge_owner_links_v1 (world_id,receipt_id,soul_id,link) VALUES (?,?,?,?) ON CONFLICT(world_id,receipt_id) DO UPDATE SET link=excluded.link');
  const drop = db.db.prepare('DELETE FROM edge_owner_links_v1 WHERE world_id=? AND receipt_id=?');
  return {
    load: () => (db.db.prepare('SELECT receipt_id,link FROM edge_owner_links_v1 WHERE world_id=?').all(worldId) as {receipt_id: string; link: string}[]).map(r => [r.receipt_id, r.link]),
    save: (receipt, soulId, link) => {save.run(worldId, receipt, soulId, link);},
    drop: receipt => {drop.run(worldId, receipt);},
  };
}
/** `steps`: the message's steps when the link is implicit and its words name some (else the act closes it, as before). */
type Link = {scope: {scope: string; owner: string}; message: string; steps?: MessageStep[]; act?: string[];
  /** #1272: other messages on this receipt: a repeated act returns the one under way, and each message still closes with it. */
  also?: Link[];
  /** #1295: the act asked for its own duration (`seconds`), so a held pose is still running; `gone`: the tick the receipt was
   *  replaced (the world closes its messages GONE_TICKS later unless another act serves them); `late`: past HOLD_TICKS, the
   *  world has said it hadn't finished. */
  timed?: number; gone?: number; late?: true};
const verbOf = (r: EdgeReceipt) => r.capability.split(':')[0];
/** What the owner still waits for, said plainly ("not resting yet"); `there` for any way of getting somewhere. */
function pending(step: string[]) {
  const v = step[0];
  return v === 'rest' || v === 'nap' || v === 'lie' ? 'resting' : v === 'sit' ? 'sitting' : step.includes('walk') ? 'there' : v === 'ride' ? 'aboard' : `${v} done`;
}
const MAX_LINKS = 2000;
const OPEN = ['waiting', 'started', 'accepted'];
/** #1295: a linked act still running this long (world ticks, 15 minutes) has its message closed `failed`, never done. */
export const HOLD_TICKS = 15 * 60 * 20;
/** #1295: how long a replaced act's messages wait for the replacing act to be linked to them (world ticks). */
export const GONE_TICKS = 40;
const SWEEP_TICKS = 20;
/** How near a named thing or Soul the body must end to be at it (metres). */
const AT_M = 6;

/** D3d: whether an act reached a step's target: its own target (`act`: the ids its capability points at, else the words
 *  after its verb) is it or a place inside the named place, or (`ended`, a terminal receipt) the body ended inside the
 *  named place or within AT_M of the named thing or Soul. */
export function reachedTarget(r: EdgeReceipt, t: StepTarget, world: Pick<OwnerLoopWorld, 'placePath' | 'posOf'>, ended = false, act?: string[]): boolean {
  const within = (path: string[] | null) => !!path?.some(p => t.places.includes(p));
  for (const id of act ?? [r.capability.slice(r.capability.indexOf(':') + 1)]) if (t.places.includes(id) || t.things.includes(id) || t.souls.includes(id) || within(world.placePath(id))) return true;
  if (!ended || r.phase !== 'completed') return false;
  const end = r.endedAt as {place?: string | null; pos?: [number, number] | null} | undefined;
  if (end?.place && within(world.placePath(end.place))) return true;
  return !!end?.pos && [...t.things, ...t.souls].some(x => {const p = world.posOf(x); return !!p && Math.hypot(p[0] - end.pos![0], p[1] - end.pos![1]) <= AT_M;});
}

/** The one line the owner's card shows when the linked act ends: the receipt's outcome summary, else its phase. */
export function resultLine(r: EdgeReceipt & {outcome?: {summary?: string}; done?: string}): {text: string; outcome: 'done' | 'failed'} | null {
  if (r.phase !== 'completed' && r.phase !== 'failed') return null;   // replaced: the act that replaced it closes the message
  // #1381: stopped at the Soul's own request: not done, and not a failure of the world (the inbox has done | failed)
  if (r.phase === 'failed' && r.code === 'act.stopped') return {text: `Stopped at your request before it finished: ${r.capability}.`, outcome: 'failed'};
  const text = r.done ?? r.outcome?.summary ?? (r.phase === 'completed' ? `${r.capability} done.` : `${r.capability} failed${r.reason ? `: ${r.reason}` : '.'}`);
  return {text, outcome: r.phase === 'completed' ? 'done' : 'failed'};
}

export class OwnerLoop {
  private links = new Map<string, Link>();
  private reached = new Map<string, number>();   // message → steps already served by an implicit link's act
  private inbox: OwnerLoopInbox;
  private read: (soulId: string, receiptId: string) => (EdgeReceipt & {outcome?: {summary?: string}; done?: string}) | null;
  private world: OwnerLoopWorld | null;
  private store: OwnerLinkStore | null;
  private holdTicks: number;
  constructor(inbox: OwnerLoopInbox, read: OwnerLoop['read'], onReceipt: (l: (r: EdgeReceipt) => void) => void, world: OwnerLoopWorld | null = null,
    {store = null, holdTicks = HOLD_TICKS}: {store?: OwnerLinkStore | null; holdTicks?: number} = {}) {
    this.inbox = inbox; this.read = read; this.world = world; this.store = store; this.holdTicks = holdTicks;
    onReceipt(r => this.ended(r));
    for (const [id, json] of store?.load() ?? []) try {this.links.set(id, JSON.parse(json) as Link);} catch {store!.drop(id);}
    inbox.closeHold = (s, id) => {const r = this.running(s, id); return r ? {receipt: r.id, capability: r.capability} : null;};
  }
  /** D3d: whether this act serves step `i` of a linked message: its verb, and (several steps, last one) its target. */
  private serves(l: Link, i: number, r: EdgeReceipt, ended: boolean): boolean {
    const st = l.steps![i]!;
    if (!st.verbs.includes(verbOf(r))) return false;
    if (l.steps!.length < 2 || i < l.steps!.length - 1) return true;
    if (st.unresolved) return false;   // the agent's own result closes it
    return !st.target || !this.world || reachedTarget(r, st.target, this.world, ended, l.act);
  }
  /** Validate `for` before the act: a message id in this Soul's box, else a refusal reason. */
  check(soul: EdgeSoul, message: unknown): string | null {
    if (typeof message !== 'string' || !message.trim()) return '`for` must be an owner message id from listen';
    return this.inbox.hasMessage(this.scope(soul), message) ? null : `no owner message ${message} for this Soul (it may be too old)`;
  }
  /** Link an accepted act's receipt to its owner message; a receipt already terminal closes the message now. Implicit
   *  (the CLI's default): true when this act cannot close the message (not its last step), so the card stays open.
   *  `seconds`: the duration the act asked for (#1295: a held pose still runs until it ends, and the hold limit allows it). */
  link(soul: EdgeSoul, receipt: EdgeReceipt, message: string, implicit = false, seconds?: number): {open: boolean} {
    const scope = this.scope(soul), text = implicit ? this.inbox.messageText?.(scope, message) : null;
    const world = this.world, steps = text ? messageSteps(text, world ? words => world.stepTarget(soul, words) : undefined) : [];
    const aim = world && steps.length > 1 && steps.at(-1)!.target ? world.actTarget(soul, receipt.capability) : null;
    const l: Link = {scope, message, ...(steps.length ? {steps} : {}), ...(aim ? {act: [aim, receipt.capability.slice(receipt.capability.indexOf(':') + 1)]} : {}), ...(seconds !== undefined ? {timed: Math.max(1, seconds)} : {})};
    const prior = this.links.get(receipt.id);
    if (prior) {l.also = [...(prior.message === message ? [] : [{...prior, also: undefined, late: undefined}]), ...(prior.also ?? []).filter(x => x.message !== message)]; if (prior.late) l.late = true;}
    this.keep(receipt.id, l);
    if (this.links.size > MAX_LINKS) this.forget(this.links.keys().next().value!);
    const open = !!l.steps && !this.serves(l, l.steps.length - 1, receipt, false);
    if (!OPEN.includes(receipt.phase)) this.ended(receipt);
    return {open};
  }
  /** #1295: the act linked to this message that is running now (not ended, not replaced, not an open-ended hold its body
   *  has reached), or null. `except`: a receipt not to count (the one ending). A link whose receipt is gone is dropped. */
  running(s: {scope: string; owner: string}, message: string, except?: string): EdgeReceipt | null {
    for (const [id, l] of [...this.links]) {
      if (id === except || l.gone !== undefined) continue;
      const mine = [l, ...(l.also ?? [])].find(x => x.message === message && x.scope.scope === s.scope && x.scope.owner === s.owner); if (!mine) continue;
      const soul = l.scope.scope.slice(5);
      try {
        const r = this.peek(soul, id);
        if (!r) {this.forget(id); continue;}
        if (!OPEN.includes(r.phase)) continue;
        if (!mine.timed && this.world?.holding?.(soul, id)) continue;
        return r as EdgeReceipt;
      } catch {/* a link that can't be read holds nothing */}
    }
    return null;
  }
  /** #1295: whether any act not replaced is still linked to this message (it will close it). */
  private serving(s: {scope: string; owner: string}, message: string) {
    return [...this.links.values()].some(l => l.gone === undefined && [l, ...(l.also ?? [])].some(x => x.message === message && x.scope.scope === s.scope && x.scope.owner === s.owner));
  }
  private peek(soulId: string, id: string) {return this.world?.brief ? this.world.brief(soulId, id) : this.read(soulId, id);}
  private ended(r: EdgeReceipt) {
    const l = this.links.get(r.id); if (!l || OPEN.includes(r.phase)) return;
    const full = this.read(r.soulId, r.id) ?? r, line = resultLine(full);
    // replaced: the act that replaced it closes the message when it is linked to it; else the world does (sweep)
    if (!line) {if (l.gone === undefined) {l.gone = r.endedTick ?? r.acceptedTick; this.keep(r.id, l);} return;}
    this.forget(r.id);
    const seen = {...r, ...(full.endedAt !== undefined ? {endedAt: full.endedAt} : {})};
    for (const one of [l, ...(l.also ?? [])]) {
      // #1295: another act linked to this message still runs: it closes the message when it ends
      const other = this.running(one.scope, one.message, r.id);
      if (other) {this.inbox.serverProgress?.(one.scope, one.message, `now: ${line.text.replace(/[.\s]+$/, '')}; ${other.capability} still going`); continue;}
      this.report(one, seen, line);
    }
  }
  /** #1295: once a second (call after each world tick): close what a replaced act left with nothing serving it, close a
   *  message whose act has run past the hold limit as not done, catch an end this process missed (a restart), and drop a
   *  link whose receipt is gone. */
  sweep(tick: number) {
    if (tick % SWEEP_TICKS) return;
    for (const [id, l] of [...this.links]) {
      try {this.sweepOne(tick, id, l);} catch {/* one link's fault never stops the others; it is looked at again next time */}
    }
  }
  private sweepOne(tick: number, id: string, l: Link) {
    const soul = l.scope.scope.slice(5), r = this.peek(soul, id);
    if (!r) {this.forget(id); return;}
    // only into a message with no result: a replacing act linked to it may have closed it already, with its real outcome
    if (l.gone !== undefined) {
      if (tick - l.gone < GONE_TICKS) return;
      for (const one of [l, ...(l.also ?? [])]) if (!this.serving(one.scope, one.message) && !this.running(one.scope, one.message)) this.inbox.serverResult(one.scope, one.message, `${r.capability} was replaced by a newer act before it finished.`, 'failed', true);
      this.forget(id);
      return;
    }
    if (!OPEN.includes(r.phase)) {const full = this.read(soul, id); if (full) this.ended(full); else this.forget(id); return;}
    // a timed act gets the time it asked for, and a minute more, before it counts as overlong
    const limit = Math.max(this.holdTicks, ...[l, ...(l.also ?? [])].map(x => x.timed ? x.timed * 20 + 1200 : 0));
    if (l.late || tick - r.acceptedTick < limit) return;
    const held = this.world?.holding?.(soul, id) ?? false;
    l.late = true; this.keep(id, l);
    for (const one of [l, ...(l.also ?? [])]) if (one.timed || !held) this.inbox.serverResult(one.scope, one.message, `${r.capability} hadn't finished after ${limit < 2400 ? `${Math.round(limit / 20)} seconds` : `${Math.round(limit / 1200)} minutes`}, so it isn't done.`, 'failed', true);
  }
  private keep(id: string, l: Link) {this.links.set(id, l); try {this.store?.save(id, l.scope.scope.slice(5), JSON.stringify(l));} catch {/* kept in memory */}}
  private forget(id: string) {this.links.delete(id); try {this.store?.drop(id);} catch {/* the sweep drops it again */}}
  private report(l: Link, seen: EdgeReceipt, line: NonNullable<ReturnType<typeof resultLine>>) {
    if (!l.steps || this.serves(l, l.steps.length - 1, seen, true)) { this.reached.delete(l.message); this.inbox.serverResult(l.scope, l.message, line.text, line.outcome); return; }
    // not the last step (or not its target): the owner sees what happened and what is still to come; the message stays open
    const last = l.steps.length - 1, at = l.steps.findIndex((_, i) => i >= (this.reached.get(l.message) ?? 0) && i < last && this.serves(l, i, seen, true));
    const reached = Math.max(this.reached.get(l.message) ?? 0, at >= 0 && line.outcome === 'done' ? at + 1 : 0);
    this.reached.set(l.message, reached); if (this.reached.size > MAX_LINKS) this.reached.delete(this.reached.keys().next().value!);
    this.inbox.serverProgress?.(l.scope, l.message, `now: ${line.text.replace(/[.\s]+$/, '')}; not ${pending(l.steps[Math.min(reached, last)]!.verbs)} yet`);
  }
  private scope(soul: EdgeSoul) {return {scope: `soul:${soul.soulId}`, owner: soul.owner};}
}
