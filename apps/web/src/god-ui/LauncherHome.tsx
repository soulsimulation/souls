// The homepage when the page is served by the world launcher
// (tools/world-launcher): the worlds on this computer, and a New world dialog
// that names a world, picks its template, starts it and opens it.
import type { ClerkSatellite } from '../clerk-satellite.ts';
import { EdenMark } from '../EdenMark.tsx';
import { BASE } from '../base-path.ts';
import { useEffect, useRef, useState } from 'react';
import './launcher-home.css';
import { useSession, userAuthHeaders } from '../auth-session.ts';

export type LauncherTemplate = { id: string; name: string; description: string; batches: number; ops?: number };
export type LauncherWorldCard = { thumbnail?: string | null; thumbnailSource?: 'owner' | 'template' | null; slug: string; name: string; basePath: string; url: string; template: string; templateName: string; createdAt: number; god: boolean; godName?: string | null; nameTag?: string | null; claimable?: boolean; souls?: number | null; entities: number | null; seq: number | null; status: string; restarts: number };
/** How people sign in on this launcher's worlds (the public Clerk settings; never a secret). */
export type LauncherAuth = { provider: 'clerk' | 'dev'; clerkSatellite?: ClerkSatellite; clerkPublishableKey?: string; clerkIssuer?: string; authenticationOrigin?: string };
export type LauncherList = { contract: 'local-worlds/1'; launcher: string; worlds: LauncherWorldCard[]; templates: LauncherTemplate[]; auth?: LauncherAuth };

const ago = (t: number) => { const s = Math.max(0, (Date.now() - t) / 1000); if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} minutes ago`; if (s < 86400 * 2) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; } return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const STATUS: Record<string, string> = { running: 'Live', starting: 'Waking up…', restarting: 'Waking up…', stopped: 'Asleep', asleep: 'Asleep', failed: 'Could not start' };

/** Top right: who is signed in, behind one round button; the menu holds the address and Sign out. */
function AccountMenu({ label, onSignOut }: { label: string | null; onSignOut: () => void }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', away); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc); };
  }, [open]);
  const initial = (label ?? '?').replace(/^dev:/, '').trim().charAt(0).toUpperCase() || '?';
  return (
    <div className="lh-account" ref={root} data-signed-in="1">
      <button className="lh-avatar" aria-label={`Account: ${label ?? 'signed in'}`} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>{initial}</button>
      {open && <div className="lh-menu" role="menu">
        <p className="lh-menu-who">{label ?? 'Signed in'}</p>
        <button role="menuitem" onClick={onSignOut}>Sign out</button>
      </div>}
    </div>
  );
}

export function LauncherHome({ initial }: { initial: LauncherList }) {
  const [list, setList] = useState(initial);
  const [dialog, setDialogRaw] = useState(() => new URLSearchParams(location.search).has('new'));
  // Clerk: a new world belongs to whoever makes it, so making one starts with signing in.
  const session = useSession();
  const needsSignIn = (session.mode === 'clerk' || session.mode === 'dev') && !session.authed;
  // a new world belongs to whoever makes it: signing in comes first, and the dialog opens once they are back (?new)
  const setDialog = (open: boolean) => {
    if (open && needsSignIn) {
      if (session.signInUrl) location.assign(session.signInUrl + '?new=1');
      else { history.replaceState(null, '', location.pathname + '?new=1'); session.login(); }
      return;
    }
    setDialogRaw(open);
  };
  useEffect(() => { if (dialog && needsSignIn && session.ready) setDialogRaw(false); }, [dialog, needsSignIn, session.ready]);
  useEffect(() => {
    const t = setInterval(() => { void fetch(`${BASE}/__sim/worlds.json`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.launcher) setList(d); }).catch(() => {}); }, 6000);
    return () => clearInterval(t);
  }, []);
  // the fullest worlds first; a world whose count is unknown goes last
  const worlds = [...list.worlds].sort((a, b) => (b.entities ?? -1) - (a.entities ?? -1));
  // two worlds with one name are told apart by their address, shown only on those cards
  const shared = new Set(worlds.map((w) => w.name).filter((n, i, all) => all.indexOf(n) !== i));
  return (
    <main className="world-list lh">
      <header className="lh-bar">
        <div className="lh-title"><EdenMark/><span className="lh-wordmark">Souls</span></div>
        <div className="lh-actions">
          <button className="lh-new" data-new-world="1" onClick={() => setDialog(true)}>{needsSignIn ? 'Sign in to make a world' : '+ New world'}</button>
          {session.authed ? <AccountMenu label={session.label} onSignOut={() => void session.logout()}/>
            : session.mode === 'clerk' ? (!session.ready ? <span className="dim">Signing in…</span>
              : <button className="lh-signin" data-home-signin="1" onClick={() => setDialog(true)}>Sign in</button>)
            : session.mode === 'dev' && <button className="lh-signin" data-home-signin="1" onClick={() => session.login()}>Sign in</button>}
        </div>
      </header>
      {worlds.length === 0 && (
        <div className="lh-empty">
          <p>No worlds yet. Be the first.</p>
          <p className="dim">Name it, pick how it starts, and hand your agent one line. About a minute.</p>
          <button className="lh-new" onClick={() => setDialog(true)}>+ New world</button>
        </div>
      )}
      {worlds.length > 0 && <h1 className="lh-h">Worlds <span className="lh-count">{worlds.length}</span></h1>}
      <div className="lh-cards">
        {worlds.map((w) => (
          <a key={w.slug} href={w.url} data-world={w.slug} className="lh-card" title={`${w.slug} · made ${ago(w.createdAt)}`}>
            {/* #887: the owner's picture, else the template's default (one shared, immutable URL); lazy, never shifts the card */}
            {w.thumbnail && <img className="lh-thumb" src={w.thumbnail} width={1280} height={720} loading="lazy" decoding="async" data-thumbnail-source={w.thumbnailSource ?? ''}
              alt={w.thumbnailSource === 'owner' ? `A view of ${w.name}` : `${w.templateName}, the template ${w.name} started from`} onError={(e) => { e.currentTarget.hidden = true; }} />}
            <span className="lh-label-over">
              <h2>{w.name}{w.nameTag && <span className="lh-tag" data-name-tag={w.nameTag}>{w.nameTag}</span>}</h2>
              {shared.has(w.name) && <p className="lh-world-slug" title={`World address: ${w.slug}`}>{w.slug}</p>}
              <p className="lh-meta" data-world-souls={w.souls ?? ''}>
                <span className={`lh-dot lh-${w.status}`} />{STATUS[w.status] ?? w.status}
                {w.souls ? ` · ${w.souls} Soul${w.souls === 1 ? '' : 's'}` : ''}{w.entities ? ` · ${w.entities.toLocaleString()} things` : ''}
                {w.god ? (w.godName ? ` · god: ${w.godName}` : '') : w.claimable === false ? <span data-not-claimable="1"> · open to visit</span> : <span className="lh-unclaimed"> · no god yet</span>}
              </p>
            </span>
          </a>
        ))}
      </div>
      <ForAgents/>
      {/* #388: the public changelog, a static page the launcher serves beside this list (apps/web/changelog.html); #897: the docs */}
      <footer className="lh-footer">
        <nav className="lh-footer-links"><a href={`${BASE}/docs`} data-docs-link="1">Docs</a><a href={`${BASE}/docs/for-agents`} data-for-agents-link="1">For agents</a><a href={`${BASE}/changelog`} data-changelog-link="1">Changelog</a><a href="https://x.com/soulsimulation" rel="noopener" target="_blank">X</a><a href="https://github.com/soulsimulation/souls" rel="noopener" target="_blank">GitHub</a></nav>
        <p className="lh-credit">Souls is an experiment by <a href="https://genekogan.com" rel="noopener" target="_blank">Gene Kogan</a></p>
      </footer>
      {dialog && <NewWorldDialog templates={list.templates} onClose={() => { setDialog(false); const q = new URLSearchParams(location.search); if (q.has('new')) history.replaceState(null, '', location.pathname); }} />}
    </main>
  );
}

/** #897: the one line a person gives their agent to start here; the page it names says what to fetch, in order. */
export const agentPrompt = (origin: string) => `Read ${origin}${BASE}/docs/for-agents and help me take part in Souls: watch a world, run a Soul for me, or build my world as its god.`;

function ForAgents() {
  const prompt = agentPrompt(location.origin), [copied, setCopied] = useState(false), box = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(t); }, [copied]);
  // no clipboard (an insecure origin, a refusal): select the line so the person can copy it themselves
  const selectLine = () => { const s = getSelection(); if (box.current && s) { s.selectAllChildren(box.current); } };
  const copy = () => { if (navigator.clipboard) void navigator.clipboard.writeText(prompt).then(() => setCopied(true), selectLine); else selectLine(); };
  return (
    <section className="lh-agents" aria-labelledby="lh-agents-h" data-for-agents="1">
      <div className="lh-agents-head">
        <h2 className="lh-h" id="lh-agents-h">Souls are for agents</h2>
        <p className="dim">Paste this line to yours and it takes it from there.</p>
        <a className="lh-agents-more" href={`${BASE}/docs/for-agents`}>How it works →</a>
      </div>
      <div className="lh-prompt">
        <p ref={box} className="lh-prompt-line" aria-label="Prompt for your agent">{prompt}</p>
        <button className="lh-copy" onClick={copy} aria-live="polite">{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </section>
  );
}

function NewWorldDialog({ templates, onClose }: { templates: LauncherTemplate[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const session = useSession();
  // shown on the homepage as this world's god; prefilled from the sign-in name, never from an email address
  const [godName, setGodName] = useState(() => { const l = (session.label ?? localStorage.getItem('sim.dev') ?? '').replace(/^dev:/, ''); return l.includes('@') ? '' : l.slice(0, 32); });
  const [template, setTemplate] = useState(templates.find((t) => t.id === 'hello-hamlet')?.id ?? templates[0]?.id ?? 'empty');
  const [state, setState] = useState<{ phase: 'edit' | 'creating' | 'error'; message?: string; started?: number }>({ phase: 'edit' });
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { if (state.phase !== 'creating') return; const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, [state.phase]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && state.phase !== 'creating') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [state.phase, onClose]);
  const slugPreview = name.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { input.current?.focus(); return; }
    setState({ phase: 'creating', started: Date.now() });
    try {
      // the creator's sign-in goes along: the launcher has the new world claim them as its god at birth
      let headers = await userAuthHeaders();
      let creator = localStorage.getItem('sim.dev') ?? undefined;
      // local test launcher (dev sign-in): the name typed here is also the local sign-in, so the creator is its god at birth, as in production
      if (session.mode === 'dev' && !headers.authorization && godName.trim()) {
        const n = godName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
        if (n) { localStorage.setItem('sim.dev', n); creator = n; headers = { authorization: `Bearer dev:${n}` }; }
      }
      const r = await fetch(`${BASE}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: name.trim(), template, creator, godName: godName.trim() || undefined }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) throw new Error(d.message ?? `the launcher answered ${r.status}`);
      location.href = d.url;
    } catch (err) { setState({ phase: 'error', message: String((err as Error).message) }); }
  };
  const secs = state.started ? Math.round((now - state.started) / 1000) : 0;
  return (
    <div className="lh-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && state.phase !== 'creating') onClose(); }}>
      <form className="lh-dialog" role="dialog" aria-modal="true" aria-labelledby="lh-dialog-title" data-new-world-dialog="1" onSubmit={create}>
        <h2 id="lh-dialog-title">A new world</h2>
        <label className="lh-label" htmlFor="lh-name">Name</label>
        <input id="lh-name" ref={input} data-world-name="1" value={name} maxLength={60} placeholder="e.g. Willow Hollow" onChange={(e) => setName(e.target.value)} disabled={state.phase === 'creating'} autoComplete="off" />
        <p className="lh-slug dim">{slugPreview ? <>It will live at <code>{BASE}/w/{/^[a-z]/.test(slugPreview) ? slugPreview : 'world-' + slugPreview}</code></> : <>&nbsp;</>}</p>
        <label className="lh-label" htmlFor="lh-god">Your name, as its god <span className="lh-opt">(shown on the world list)</span></label>
        <input id="lh-god" data-god-name="1" value={godName} maxLength={32} placeholder="e.g. Gene" onChange={(e) => setGodName(e.target.value)} disabled={state.phase === 'creating'} autoComplete="off" />
        <fieldset className="lh-templates" disabled={state.phase === 'creating'}>
          <legend className="lh-label">Starts as</legend>
          {templates.map((t) => (
            <label key={t.id} className={'lh-template' + (template === t.id ? ' on' : '')} data-template={t.id}>
              <input type="radio" name="template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <span><b>{t.name}</b><span className="lh-desc" title={t.description}>{t.description || (t.batches ? `${t.batches} building steps` : '')}</span></span>
            </label>
          ))}
        </fieldset>
        <p className="lh-after dim">Next: the world opens and gives you one line to paste to your agent (Claude Code, Codex…). Approve the code it shows, and it starts building.</p>
        {state.phase === 'error' && <p className="bad" data-create-error="1">Could not create the world: {state.message}</p>}
        <div className="lh-actions">
          <button type="button" className="lh-cancel" onClick={onClose} disabled={state.phase === 'creating'}>Cancel</button>
          <button type="submit" className="lh-create" data-create="1" disabled={state.phase === 'creating' || !name.trim()}>{state.phase === 'creating' ? `Starting the world… ${secs}s` : 'Create world'}</button>
        </div>
        {state.phase === 'creating' && <p className="lh-wait dim">A world takes 10–30 seconds to start the first time{template !== 'empty' ? ' (the template is being built through the same validated edits your agent will use)' : ''}.</p>}
      </form>
    </div>
  );
}
