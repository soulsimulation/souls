// Forsake world on a world the new engine runs (#5006 rows 16 and 38), its own chunk: GodPanel loads it only when the
// creator opens Forsake (rarely), so the panel's own bundle does not carry it.
import { useState } from 'react';
import { CopyButton } from './markdown.tsx';
import { archiveWorld, cancelHandoff, forsakeHere, offerHandoff, offerLink } from './v2-forsake.ts';
/** Forsake world on a world the new engine runs (#5006 rows 16 and 38): the same two danger zones, asked of the world's
 *  directory (v2-forsake.ts), which holds its creator. Handing on is a one-use link the recipient accepts signed in;
 *  archiving stops the world and keeps every part of it. There are no co-builders (one creator per world). */
export function V2ForsakeWorld({ name, here = forsakeHere() }: { name: string; here?: ReturnType<typeof forsakeHere> }) {
  const [link, setLink] = useState<{ url: string; expires: number } | null>(null);
  const [handing, setHanding] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [archived, setArchived] = useState<'archived' | 'pending' | null>(null);
  if (!here) return <div className="gm-forsake" data-owner-ops="v2"><p className="gm-danger-note bad" role="status">This page does not name its world's directory, so the world cannot be handed on or archived from here.</p></div>;
  const { place, world } = here;
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setNote(null);
    try { await fn(); } catch (e) { setNote({ text: (e as Error).message, bad: true }); } finally { setBusy(null); }
  };
  const offer = () => run('transfer', async () => { const o = await offerHandoff(place, world); setLink({ url: offerLink(location.href, o.code), expires: o.expires }); setHanding(false); });
  const cancel = () => run('cancel', async () => { await cancelHandoff(place, world); setLink(null); setNote({ text: 'Any open link is cancelled. Nobody can accept it now.' }); });
  const archive = () => run('archive', async () => setArchived(await archiveWorld(place, world, confirm)));

  return (
    <div className="gm-forsake" data-owner-ops="v2">
      <p className="gm-forsake-lead">Both of these take <b>{name}</b> out of your hands. Your agent stops being its creator.</p>
      <section className="gm-danger" data-ops="transfer">
        <h3>Hand it on</h3>
        <p>Make a one-use link (valid 7 days). Whoever opens it, signed in, and accepts becomes this world's creator, and your agent loses access. The world, its Souls and everything built stay as they are.</p>
        {link
          ? <div className="gm-danger-link" data-ops-link="transfer"><span>Send this only to them:</span><div className="gm-danger-row"><code>{link.url}</code><CopyButton text={link.url} /></div></div>
          : handing
            ? <div className="gm-danger-confirm" role="group" aria-label="Confirm the handoff link">
              <p>Create the link? Anyone who has it can take this world until you cancel it or make a new one.</p>
              <div className="gm-danger-row">
                <button type="button" className="gm-danger-btn" data-ops-transfer-confirm="1" disabled={!!busy || !!archived} onClick={() => void offer()}>{busy === 'transfer' ? 'Creating…' : 'Yes, create the link'}</button>
                <button type="button" className="gm-quiet" onClick={() => setHanding(false)}>Cancel</button>
              </div>
            </div>
            : <button type="button" className="gm-danger-ghost" data-ops-transfer="1" disabled={!!busy || !!archived} onClick={() => setHanding(true)}>Create a handoff link…</button>}
        <div className="gm-danger-row gm-danger-pending"><span>{link ? 'This link is open.' : 'An earlier link stays open until it is used, cancelled or replaced.'}</span><button type="button" className="gm-quiet" data-ops-cancel="1" disabled={!!busy || !!archived} onClick={() => void cancel()}>{link ? 'Cancel it' : 'Cancel any open link'}</button></div>
      </section>
      <section className="gm-danger" data-ops="archive">
        <h3>Archive</h3>
        <p>Stops the world and takes it off the list. Nothing is deleted: its Souls, history and address are kept, and an operator can restore it. While other people's Souls live here it cannot be archived: hand it on instead, or wait until they have left.</p>
        {archived === 'archived'
          ? <p className="gm-danger-note" role="status" data-ops-archived="archived">Archived. Its data is kept; an operator can restore it.</p>
          : <>
            {archived === 'pending' && <p className="gm-danger-note" role="status" data-ops-archived="pending">Archiving: the world is stopping. Its data is kept. Select Check again to read the same request.</p>}
            <label className="gm-danger-label" htmlFor="gm-archive-confirm">Type <code>{world}</code> to confirm</label>
            <div className="gm-danger-row">
              <input id="gm-archive-confirm" data-ops-confirm="1" value={confirm} autoComplete="off" spellCheck={false} onChange={(e) => setConfirm(e.target.value.trim())} placeholder={world} />
              <button type="button" className="gm-danger-btn" data-ops-archive="1" disabled={confirm !== world || !!busy} onClick={() => void archive()}>{busy === 'archive' ? 'Archiving…' : archived === 'pending' ? 'Check again' : 'Archive world'}</button>
            </div>
          </>}
      </section>
      {note && <p className={'gm-danger-note' + (note.bad ? ' bad' : '')} role="status">{note.text}</p>}
    </div>
  );
}
