// The proof clip's optional debug panel (#1644): the exchange between a Soul's agent and the world (commands, the
// world's replies, receipt phases), in time order, stacked beside the world (landscape) or below it (portrait).
// Entries are logged during the take, redacted, checked by the publication checker, then drawn after the take as one
// image per change, so the panel is exact to the logged time and adds no work to the take itself.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicationFindings } from './publication.mjs';

export const DIRS = { cmd: '→', reply: '←', receipt: '•', note: '·' };
const MAX_TEXT = 160;
const ID_KINDS = { s: 'soul', r: 'receipt', e: 'entity', u: 'undo', w: 'world', c: 'cursor', a: 'account', sp: 'speech', p: 'program', cv: 'conversation' };

/** A redactor that keeps order meaning: the same private id always becomes the same ordinal ("receipt-2"). */
export function makeRedactor() {
  const seen = new Map(), counts = {};
  const ordinal = (kind, raw) => { const k = `${kind}:${raw}`; if (!seen.has(k)) seen.set(k, `${kind}-${(counts[kind] = (counts[kind] ?? 0) + 1)}`); return seen.get(k); };
  return (text) => {
    let s = String(text ?? '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\b[a-z][\w+.-]*:\/\/[^\s"'<>)]+/gi, '<url>')                               // any URL (local worlds included)
      .replace(/(?:^|(?<=[\s"'=(:]))(?:~[\w.-]*|\/(?:Users|home|private|var|tmp|root|Volumes|opt|etc|mnt|srv|data)\b)[^\s"',)]*/g, '<path>')
      .replace(/\b[A-Za-z]:\\[^\s"',)]*/g, '<path>')
      .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 <token>')
      .replace(/\b(token|secret|password|passwd|apikey|api_key|key|auth|authorization|cookie)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<token>')
      .replace(/\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>')
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
      .replace(/\b([a-z]{1,3})_([0-9a-f]{8}-[0-9a-f-]{27,}|(?=[\w-]*\d)[A-Za-z0-9_-]{6,})\b/g, (m, p, id) => ordinal(ID_KINDS[p] ?? 'id', `${p}_${id}`))
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => ordinal('id', m))
      .replace(/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{24,}={0,2}/g, '<token>')
      .replace(/\b[0-9a-f]{16,}\b/gi, '<token>');
    return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
  };
}

/** finalizePanel(entries) → {entries, findings}: sorted by time, redacted, and checked by the publication checker.
 *  Any finding fails the take: nothing is drawn. */
export function finalizePanel(raw, { redact = makeRedactor(), findings = publicationFindings } = {}) {
  const entries = raw.filter((e) => Number.isFinite(e?.at) && e.at >= 0 && e.text != null)
    .map((e, i) => ({ i, at: +e.at.toFixed(2), dir: DIRS[e.dir] ? e.dir : 'note', text: redact(e.text) }))
    .sort((a, b) => a.at - b.at || a.i - b.i).map(({ i, ...e }) => e);
  return { entries, findings: findings(entries.map((e) => e.text)) };
}

/** A reply in one line: what the world said, not its whole JSON. */
export function summarizeReply(stdout, code) {
  let j = null; try { j = JSON.parse(stdout); } catch { /* not JSON */ }
  if (!j || typeof j !== 'object') { const t = String(stdout ?? '').trim().split('\n')[0] ?? ''; return code ? `error (exit ${code}) ${t}` : t || 'ok'; }
  const parts = [];
  if (j.said) parts.push(`said (${j.said.channel?.kind ?? 'speech'}${Array.isArray(j.said.heardBy) ? `, heard by ${j.said.heardBy.length}` : ''})`);
  if (typeof j.phase === 'string') parts.push(`${j.capability ? `${j.capability} ` : ''}${j.phase}${j.endedAt?.placePath?.[0] ? ` at ${j.endedAt.placePath[0]}` : ''}${j.code ? ` (${j.code})` : ''}`);
  if ('accepted' in j) parts.push(j.accepted ? 'accepted' : `refused ${j.code ?? ''}`.trim());
  if (j.receipt?.id) parts.push(`receipt ${j.receipt.id}${j.receipt.phase ? ` ${j.receipt.phase}` : ''}`);
  if (typeof j.now === 'string') parts.push(`now: ${j.now}`);
  if (typeof j.done === 'string') parts.push(`done: ${j.done}`);
  if (!parts.length && j.reason) parts.push(String(j.reason));
  if (!parts.length) parts.push(JSON.stringify(j).slice(0, 120));
  return parts.join(' · ');
}

const TERMINAL = new Set(['completed', 'failed', 'replaced', 'cancelled', 'canceled', 'refused']);

/** The log the steps write to. `eden(dir, args)` runs one Soul CLI command in that Soul's folder and logs the command,
 *  the reply and (for an act) each receipt phase until it ends or the take does. */
export function panelLog({ since, eden = resolve('tools/world-launcher/soul/eden.mjs'), pollMs = 1000 } = {}) {
  const entries = [], timers = new Set();
  let open = true;
  const at = () => (Date.now() - since()) / 1000;
  const add = (dir, text) => { if (open) entries.push({ at: at(), dir, text: String(text) }); };
  const run = (dir, args) => new Promise((done) => {
    let out = '';
    const child = spawn(process.execPath, [eden, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => { out += d; });
    child.once('exit', (code) => done({ out, code }));
    child.once('error', () => done({ out, code: 1 }));
  });
  const watch = (dir, id) => {
    let last = null;
    const tick = async () => {
      if (!open) return;
      const { out } = await run(dir, ['receipt', id]);
      let phase = null, j = null; try { j = JSON.parse(out); phase = j.phase ?? j.receipt?.phase ?? null; } catch { /* keep polling */ }
      if (phase && phase !== last) { add('receipt', `receipt ${id} ${phase}${TERMINAL.has(phase) && j.endedAt?.placePath?.[0] ? ` at ${j.endedAt.placePath[0]}` : ''}`); last = phase; }
      if (open && !TERMINAL.has(phase)) { const t = setTimeout(() => { timers.delete(t); tick(); }, pollMs); t.unref?.(); timers.add(t); }
    };
    tick();
  };
  return {
    entries,
    panel: (text, dir = 'note') => add(dir, text),
    async eden(dir, args, { watchReceipt = true } = {}) {
      add('cmd', `eden ${args.join(' ')}`);
      const { out, code } = await run(dir, args);
      add('reply', summarizeReply(out, code));
      let j = null; try { j = JSON.parse(out); } catch { /* text reply */ }
      if (watchReceipt && j?.receipt?.id) watch(dir, j.receipt.id);
      return { json: j, stdout: out, code };
    },
    stop() { open = false; for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}

/** Entries another process logged: one JSON object per line, {at: epoch ms, dir, text}. */
export function readPanelFile(file, t0) {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => {
    try { const e = JSON.parse(l); return Number.isFinite(e.at) ? [{ ...e, at: (e.at - t0) / 1000 }] : []; } catch { return []; }
  });
}

/** The panel states: state k shows entries[0..k-1], from its time until the next change. */
export function panelStates(entries, durationSec) {
  const times = [...new Set(entries.map((e) => Math.min(e.at, durationSec)))].sort((a, b) => a - b);
  const starts = [0, ...times.filter((t) => t > 0)];
  return starts.map((start, k) => ({ start, end: k + 1 < starts.length ? starts[k + 1] : durationSec, shown: entries.filter((e) => e.at <= start) }))
    .filter((s) => s.end > s.start);
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** The panel's HTML for one state, newest line at the bottom; whole lines that don't fit scroll off the top. A bottom
 *  panel keeps its last 30 px clear for the timecode chip. */
export function panelHtml(shown, { side }) {
  const rows = shown.map((e) => `<li class="${e.dir}"><time>${clock(e.at)}</time><b>${DIRS[e.dir]}</b><span>${esc(e.text)}</span></li>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#14161a;color:#e8e6e1;font:14px/1.35 ui-monospace,Menlo,Consolas,monospace}
body{display:flex;flex-direction:column;box-sizing:border-box;padding:10px 12px ${side === 'right' ? 10 : 30}px;${side === 'right' ? 'border-left' : 'border-top'}:1px solid #2c3038}
h1{font:600 13px/1.2 system-ui,sans-serif;margin:0 0 8px;color:#a9b0bb;letter-spacing:.02em}
ul{list-style:none;margin:0;padding:0;flex:1;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden}
li{display:grid;grid-template-columns:auto auto 1fr;gap:6px;padding:2px 0;overflow-wrap:anywhere}
time{color:#7d8592}b{font-weight:700}.cmd b{color:#ffc400}.reply b{color:#6fd3ff}.receipt b{color:#8be28b}.note b{color:#a9b0bb}
.cmd span{color:#fff1c2}</style><h1>Soul ↔ world (debug)</h1><ul>${rows}</ul>
<script>const u=document.querySelector('ul'),top=()=>u.getBoundingClientRect().top;while(u.firstChild&&u.firstChild.getBoundingClientRect().top<top()-0.5)u.firstChild.remove();</script>`;
}
