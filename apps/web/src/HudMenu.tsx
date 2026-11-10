import { useCallback, useEffect, useRef, useState } from 'react';
import { BASE } from './base-path.ts';
import { collectMenuRows, MENU_CLASS, setMenuSoulsSlot, type MenuRow } from './hud-menu.ts';

// #1391 (Gene): "On phone widths, replace the floating controls with a hamburger button and a menu": the hamburger is
// styled like the logo (a black circle, white lines); the menu is a slightly translucent panel holding everything, in
// order: Worlds, Time, Search, Souls, God mode, Music, Camera mode, and sign-in or profile at the bottom. The rows click
// the existing (hidden) controls (hud-menu.ts), as HudMore's More does.

const halo = new URL('../pwa/icon-mark.png', import.meta.url).href;
const LINES = <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M4 10h12M4 14h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none"/></svg>;

/** The phone hamburger and its menu. `initialOpen` is for tests. */
export function HudMenu({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [rows, setRows] = useState<MenuRow[]>([]);
  const root = useRef<HTMLSpanElement>(null), button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const html = document.documentElement; html.classList.add(MENU_CLASS);
    return () => html.classList.remove(MENU_CLASS);
  }, []);
  useEffect(() => {
    if (!open) return;
    setRows(collectMenuRows(document));
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const choose = (row: MenuRow) => { setOpen(false); row.target.click(); };
  // part b: MySouls portals the inline Souls list here (between Search and New Soul); choosing a Soul closes the menu
  const soulsSlot = useCallback((el: HTMLDivElement | null) => setMenuSoulsSlot(el, () => setOpen(false)), []);
  const before = rows.filter((r) => r.section === 'time' || r.section === 'search'), after = rows.filter((r) => !before.includes(r));
  const row = (r: MenuRow, i: number, list: MenuRow[]) => // New Soul sits under the Souls list, which draws its own rule
     <button key={r.key} type="button" role="menuitem" className="hud-menu-row" data-menu={r.key} data-section={r.section}
    data-section-start={(i === 0 ? !(list === after && r.section === 'souls') : list[i - 1].section !== r.section) || undefined} onClick={() => choose(r)}>
    <span>{r.label}</span>{r.value && <span className="hud-menu-value">{r.value}</span>}
  </button>;
  return (
    <span ref={root} className="hud-menu-wrap">
      <button ref={button} type="button" className="hud-menu" aria-label="Menu" title="Menu" aria-haspopup="menu" aria-expanded={open} aria-controls="hud-menu-panel" onClick={() => setOpen(!open)}>{LINES}</button>
      <div id="hud-menu-panel" className="hud-menu-panel" role="menu" aria-label="Menu" data-open={open} inert={!open}>
        <a role="menuitem" className="hud-menu-row hud-menu-worlds" href={BASE + '/'}><img src={halo} width="24" height="24" alt="" aria-hidden="true" /><span>Worlds</span></a>
        {before.map((r, i, list) => row(r, i, list))}
        <div ref={soulsSlot} className="hud-menu-souls-slot" />
        {after.map((r, i, list) => row(r, i, list))}
      </div>
    </span>
  );
}
