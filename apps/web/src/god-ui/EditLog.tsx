// #5006 row 14: God Mode's edit log on a world the new engine runs. The creator's edits, newest first, a page at a time
// ("Earlier"), read from the world's public event index in its history export (v2-engine/edit-log.ts), never from the
// world itself. Who: "You" for this creator's grant, else "Another creator". What: the edit's words, naming things as
// the page's stream shows them. When: world time ago. The first page is read again every REFRESH_MS while God Mode is
// open and no earlier page has been asked for (the world writes its open day's index at most every 5 s). GodPanel loads
// this module when the creator opens God Mode on such a world, so a visitor loads none of it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { decode as cbor } from 'cborg';
import { editPage, editWords, fetchGet, type Edit, type EditRow } from '../v2-engine/edit-log.ts';
import { buildNodes } from '../v2-engine/creator-build.ts';
import { v2HistoryBase } from '../v2-engine/history.ts';
import { ago } from './GodModal.tsx';

export const REFRESH_MS = 10_000;
/** World time now, µs: the stream's newest (use-v2-souls.ts `__soulsV2`), else the clock (world time is wall time). */
const worldNowUs = () => {
  const t = (window as unknown as { __soulsV2?: { newestTo?: number | null } }).__soulsV2?.newestTo;
  return typeof t === 'number' ? t : Date.now() * 1000;
};

/** The log, when the page reads this world's history export (history.ts `v2HistoryBase`); else nothing. */
export function EditLog({ grant }: { grant: string | null }) {
  const base = v2HistoryBase();
  return base ? <EditList base={base} grant={grant} /> : null;
}

function EditList({ base, grant }: { base: string; grant: string | null }) {
  const [edits, setEdits] = useState<Edit[] | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [earlier, setEarlier] = useState(false);
  const cache = useRef(new Map<number, EditRow[]>());
  const read = useCallback((from?: number) => editPage({ get: fetchGet(base), decode, now: worldNowUs(), before: from, cache: cache.current }), [base]);
  useEffect(() => {
    if (earlier) return;
    let live = true;
    const first = () => void read().then((p) => { if (live) { setEdits(p.edits); setBefore(p.before); setError(''); } })
      .catch(() => { if (live) setError('The edit log could not be read. Retrying…'); });
    first();
    const t = setInterval(first, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [read, earlier]);
  const more = async () => {
    if (before === null || busy) return;
    setBusy(true); setEarlier(true);
    try { const p = await read(before); setEdits((e) => [...(e ?? []), ...p.edits]); setBefore(p.before); setError(''); }
    catch { setError('The earlier edits could not be read. Try again.'); }
    finally { setBusy(false); }
  };
  const me = grant?.replace(/^creator-/, '') ?? null, nodes = buildNodes(), nowMs = worldNowUs() / 1000;
  return <section className="gm-more gm-edits" data-edit-log={edits?.length ?? ''} aria-label="Edits, newest first">
    <h3 className="gm-h">Edits</h3>
    {edits && !edits.length && <p className="gm-empty" data-edit-log-empty="1">No edits in the last week. Each place, move, change, undo and redo shows here.</p>}
    {!!edits?.length && <ol className="gm-edit-list">
      {edits.map((e) => <li key={`${e.at} ${e.creator}`} data-edit-at={e.at}>
        <span className="gm-edit-what">{editWords(e, nodes)}</span>
        <span className="gm-edit-meta"><span>{e.creator === me ? 'You' : 'Another creator'}</span>
          <span className="gm-when" title={new Date(e.at / 1000).toLocaleString()}>{ago(e.at / 1000, nowMs)}</span></span>
      </li>)}
    </ol>}
    {error && <p className="gm-error" role="status">{error}</p>}
    {before !== null && <button type="button" className="gm-textbtn gm-edits-earlier" data-edit-log-earlier="1" disabled={busy} onClick={() => void more()}>{busy ? 'Reading…' : 'Earlier'}</button>}
  </section>;
}

/** One object of the index as T0's CBOR, maps as Maps (cborg, as history.ts reads the history). */
const decode = (bytes: Uint8Array): unknown => cbor(bytes, { useMaps: true });
