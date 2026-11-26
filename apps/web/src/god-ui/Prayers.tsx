// G5 (Gene 2026-10-20b): prayers are like notifications. Above the God Mode log, the prayers still waiting for an answer,
// each with Answer; nothing at all when none are waiting. The same calls the god's agent makes (`prayers`, `answer`).
// #5006 row 15: on a world the new engine runs they come from the creator's own socket (`source`, V2Creator's
// `prayers` and `answerPrayer`), the directory's list for this creator's worlds only, as `souls-god prayers` reads it.
import { useCallback, useEffect, useState } from 'react';
import * as V from './governance-api.ts';
import { ago } from './GodModal.tsx';
import type { V2Prayer } from '../v2-engine/creator-socket.ts';

/** Where the panel's prayers come from on a world the new engine runs: the waiting ones, and an answer to one. */
export type PrayerSource = { waiting: () => Promise<V2Prayer[]>; answer: (id: string, text: string) => Promise<unknown>; nameOf?: (grant: string) => string | null };

/** A Soul's page id from its grant (v2-engine/bridge.ts `soulIdOf`, not imported: that module is the viewer's). */
export const soulIdOf = (grant: string) => `s_${grant.replace(/^soul-/, '').replace(/[^0-9a-z_-]/gi, '_')}`;

/** The directory's prayer as the panel shows one: the Soul's name where the page knows it, its time in ms. */
export const shownPrayer = (p: V2Prayer, nameOf?: (grant: string) => string | null): V.Prayer =>
  ({ id: p.id, soul_name: nameOf?.(p.soul) || 'A Soul', text: p.text, at: p.at * 1000, answer: p.answer, answered_at: p.answered_at === null ? null : p.answered_at * 1000 });

export function PrayersWaiting({ source }: { source?: PrayerSource } = {}) {
  const [prayers, setPrayers] = useState<V.Prayer[] | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = useCallback(() => (source ? source.waiting().then((v) => v.map((p) => shownPrayer(p, source.nameOf))) : V.prayers()).then(setPrayers).catch(() => {}), [source]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 10_000); return () => clearInterval(t); }, [load]);
  const waiting = (prayers ?? []).filter((p) => p.answer === null);
  if (!waiting.length) return null;
  const send = async (p: V.Prayer) => {
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try { await (source ? source.answer(p.id, text.trim()) : V.answer(p.id, text.trim())); setAnswering(null); setText(''); await load(); }
    catch (e) { setError((e as Error).message || 'The answer did not reach the world. Try again.'); }
    finally { setBusy(false); }
  };
  return <section className="gm-prayers" data-prayers={waiting.length} aria-label="Prayers waiting for an answer">
    <h3 className="gm-h">{waiting.length === 1 ? '1 prayer' : `${waiting.length} prayers`} waiting</h3>
    <ul>
      {waiting.map((p) => <li key={p.id} data-prayer={p.id}>
        <p className="gm-pray-text"><b>{p.soul_name}</b> {p.text}</p>
        {answering === p.id
          ? <form className="gm-answer" onSubmit={(e) => { e.preventDefault(); void send(p); }}>
            <input autoFocus value={text} maxLength={2000} placeholder={`Your answer to ${p.soul_name}`} aria-label={`Your answer to ${p.soul_name}`} data-answer-text={p.id} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="gm-small gm-small-primary" disabled={!text.trim() || busy} data-answer-send={p.id}>{busy ? 'Sending…' : 'Answer'}</button>
            <button type="button" className="gm-textbtn" onClick={() => { setAnswering(null); setText(''); }}>Cancel</button>
          </form>
          : <div className="gm-pray-meta"><span>{ago(p.at)}</span><button type="button" className="gm-textbtn" data-answer={p.id} onClick={() => { setAnswering(p.id); setText(''); setError(''); }}>Answer</button></div>}
      </li>)}
    </ul>
    {error && <p className="gm-error" role="alert">{error}</p>}
  </section>;
}
