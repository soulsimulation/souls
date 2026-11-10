/** #892 phone navigation: the bottom chip. When a touch followed a Soul (one tap on its body or name plate, or a swipe), the
 * Soul's card collapses to this chip: its name, its status line and a "Card" button that opens the full card. In Broadcast
 * on a touch screen it reads "Now showing <name>" with a Follow button. A short note (a swipe with no other Soul here)
 * replaces the status line for a moment. It only reads the viewer's state; every camera move is the viewer's own. */
import {useEffect, useState} from 'react';
import {slowedText, type Slowed} from './soul-state.ts';

export type SoulChipProps =
  | { kind: 'follow'; name: string; status: string; note?: string; slowed?: Slowed | null; openCard(): void }
  | { kind: 'broadcast'; name: string; follow(): void };

/** #456: while the world slows or refuses this Soul, its line stands in for the status, and goes at `until` on its own. */
function useSlowed(s: Slowed | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => { if (!s) return; const ms = s.until - Date.now(); if (ms <= 0) return; const t = setTimeout(() => tick((n) => n + 1), ms + 50); return () => clearTimeout(t); }, [s?.until, s?.reason]);
  return slowedText(s ?? null);
}

export function SoulChip(props: SoulChipProps) {
  const slowed = useSlowed(props.kind === 'follow' ? props.slowed : null);
  return <div className="soul-chip" data-chip={props.kind} role="group" aria-label={props.kind === 'follow' ? `Following ${props.name}` : `Now showing ${props.name}`}>
    <div className="soul-chip-text">
      {props.kind === 'follow'
        ? <><b className="soul-chip-name">{props.name}</b><span className="soul-chip-status" role={props.note || slowed ? 'status' : undefined} data-slowed={slowed ? '1' : undefined}>{props.note || slowed || props.status || 'Following'}</span></>
        : <><span className="soul-chip-status">Now showing</span><b className="soul-chip-name">{props.name}</b></>}
    </div>
    {props.kind === 'follow'
      ? <button type="button" className="soul-chip-action" onClick={props.openCard}>Card</button>
      : <button type="button" className="soul-chip-action primary" onClick={props.follow}>Follow</button>}
  </div>;
}
