import { requestFeedback } from './feedback-request.ts';

// #1391 (Gene): on phone widths the floating top-bar controls give way to one hamburger and a menu. Like HudMore (P6),
// the menu re-hosts the existing controls: each row clicks the control it stands for, which stays mounted (hidden by
// html.phone-menu, world-chrome.css), so every component and its behaviour stay as they are.

export const PHONE_WIDTH = '(max-width: 700px)';
export const MENU_CLASS = 'phone-menu';

export type MenuSection = 'time' | 'search' | 'souls' | 'god' | 'music' | 'camera' | 'extra' | 'account';

/** The rows after Worlds, in the issue's order. `value` reads the control's current state for the row's second line. */
export const MENU_TARGETS: readonly { key: string; section: MenuSection; selector: string; label?: string; value?: (root: MenuRoot) => string; fallback?: () => void; unless?: string }[] = [
  { key: 'time', section: 'time', selector: '.hud-status .world-time-button', label: 'Time', value: (root) => text(root, '.hud-status [data-viewer-status]') },
  { key: 'search', section: 'search', selector: '.hud-explore-group .explore-open:not(.god-open)', label: 'Search' },
  // the Souls list (part b) carries its own New Soul; this row stands in when you have no Souls yet
  { key: 'new-soul', section: 'souls', selector: '.hud-explore-group .bring-agent-open', label: 'New Soul', unless: '.hud-menu-souls' },
  { key: 'god', section: 'god', selector: '[data-god-open]', label: 'God mode' },
  { key: 'claim', section: 'god', selector: '[data-god-panel-toggle]' },
  { key: 'music', section: 'music', selector: '.hud-left .navbar-audio .navbar-menu-trigger', label: 'Music' },
  { key: 'camera', section: 'camera', selector: '.hud-camera-slot .camera-menu .navbar-menu-trigger', label: 'Camera', value: (root) => text(root, '.hud-camera-slot .camera-main span') },
  // the same two as HudMore's More: Feedback lives in the account menu when signed in, so signed out the row asks directly
  { key: 'feedback', section: 'extra', selector: '[data-feedback-open]', label: 'Feedback', fallback: requestFeedback },
  { key: 'visitor', section: 'extra', selector: '.visitor-controls button' },
  { key: 'sign-in', section: 'account', selector: '.hud-actions .account-sign-in', label: 'Sign in' },
  { key: 'profile', section: 'account', selector: '.hud-actions .account-avatar', label: 'Profile' },
];

type MenuTarget = Pick<HTMLElement, 'click' | 'textContent' | 'getAttribute' | 'hidden'>;
export type MenuRoot = { querySelectorAll(selector: string): ArrayLike<MenuTarget>; querySelector?(selector: string): MenuTarget | null };
export type MenuRow = { key: string; section: MenuSection; label: string; value?: string; target: Pick<MenuTarget, 'click'> };

function text(root: MenuRoot, selector: string): string {
  const el = root.querySelectorAll(selector)[0];
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The menu's rows: every listed control on the page (hidden or not), in menu order; a control that is absent (no God
 * button for a visitor, no Music on a page without it) has no row. `fallback` stands in when the page has no control. */
export function collectMenuRows(root: MenuRoot): MenuRow[] {
  const rows: MenuRow[] = [];
  for (const t of MENU_TARGETS) {
    if (t.unless && root.querySelectorAll(t.unless).length) continue;
    const found = Array.from(root.querySelectorAll(t.selector));
    found.forEach((target, i) => {
      if (target.hidden) return;
      const label = t.label ?? target.getAttribute('aria-label') ?? (target.textContent ?? '').replace(/^\s*✦\s*/, '').trim();
      if (!label) return;
      const value = t.value?.(root) || undefined;
      rows.push({ key: i ? `${t.key}-${i}` : t.key, section: t.section, label, ...(value ? { value } : {}), target });
    });
    if (!found.length && t.fallback && t.label) rows.push({ key: t.key, section: t.section, label: t.label, target: { click: t.fallback } });
  }
  return rows;
}

/** Show up to this many of your Souls in the menu before "Show more" (#1391 part b). */
export const MENU_SOULS_SHOWN = 5;

/** The visible slice of `ids`: the first MENU_SOULS_SHOWN unless expanded, and how many are hidden. */
export function menuSoulsShown<T>(all: readonly T[], expanded: boolean): { shown: readonly T[]; hidden: number } {
  const shown = expanded ? all : all.slice(0, MENU_SOULS_SHOWN);
  return { shown, hidden: all.length - shown.length };
}

// #1391 part b: the open menu offers a slot for the Souls list. MySouls (mounted, hidden, in the top bar) portals its
// inline list into it, so the list is the same component with the same data and click behaviour as the top bar's.
type SoulsSlot = { el: HTMLElement | null; close: () => void };
let soulsSlot: SoulsSlot = { el: null, close: () => {} };
const slotListeners = new Set<() => void>();
export function setMenuSoulsSlot(el: HTMLElement | null, close: () => void) {
  if (soulsSlot.el === el) return;
  soulsSlot = { el, close }; for (const f of slotListeners) f();
}
export const menuSoulsSlot = (): SoulsSlot => soulsSlot;
export function subscribeMenuSoulsSlot(f: () => void) { slotListeners.add(f); return () => { slotListeners.delete(f); }; }
