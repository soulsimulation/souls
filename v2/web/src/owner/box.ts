// The owner's box (Engine v2 W10, #2802): a person writes to their Soul's agent from the Soul's page, and sees what the
// agent is doing about it. The words travel R13's mailbox (the directory's, beside the accounts; never a world event):
// the page puts them through the gateway on its view socket (V13), which checks its view token holds that Soul. What
// is being done is the gateway's account of the Soul's own intents and their answers since the agent picked the
// message up, then the agent's own close. Nothing here makes the Soul act: the mind stays with the agent.
//
// Text frames on the view socket (gatewayd's `mailbox.rs`):
// - page → gateway: `put <grant>\n<words>`.
// - gateway → page: `{"sent": {"id"}}` or `{"sent": {"refused"}}`, then for each message `{"mail": {"id", "state":
//   "picked"}}`, `{"doing": {"seq", "verb", "phase", "outcome"}}` for each of the agent's intents while it is open,
//   and `{"close": {"id", "state", "outcome"}}`.
//
// The agent's words and the world's names are drawn as text (`textContent`), never as markup.

/** One message as the page shows it. */
export type Message = {
  words: string;
  id: string | null;
  /** sending → waiting (in the mailbox) → thinking (the agent has it) → doing → done | failed; or refused. */
  state: 'sending' | 'waiting' | 'thinking' | 'doing' | 'done' | 'failed' | 'refused';
  /** The newest act the agent began for it: its verb, phase (the answer's own) and outcome. */
  act: { verb: string; phase: string; outcome: string | null } | null;
  /** The close's outcome, or the refusal's name. */
  outcome: string | null;
};

const OPEN = new Set(['thinking', 'doing']);

/** The longest message, in bytes (the mailbox's). */
export const WORDS_MOST = 2000;

/** The box's state, fed the gateway's text frames. */
export class OwnerBox {
  readonly messages: Message[] = [];
  private readonly picked = new Set<string>();
  /** Called after any change. */
  onChange: () => void = () => {};

  /** The frame that puts `words` for `grant`, and the message it stands for; null for empty or long words. */
  put(grant: string, words: string): string | null {
    const w = words.trim();
    if (!w || new TextEncoder().encode(w).length > WORDS_MOST) return null;
    this.messages.push({ words: w, id: null, state: 'sending', act: null, outcome: null });
    this.onChange();
    return `put ${grant}\n${w}`;
  }

  /** One text frame from the gateway; false if it is not the box's. */
  text(frame: string): boolean {
    let f: Record<string, Record<string, unknown>>;
    try {
      f = JSON.parse(frame);
    } catch {
      return false;
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const byId = (id: unknown) => this.messages.find((m) => m.id !== null && m.id === id);
    if (f.sent) {
      const m = this.messages.find((x) => x.state === 'sending');
      if (!m) return true;
      if (str(f.sent.id)) (m.id = str(f.sent.id)), (m.state = this.picked.delete(m.id!) ? 'thinking' : 'waiting');
      else (m.state = 'refused'), (m.outcome = str(f.sent.refused) ?? 'refused');
    } else if (f.mail) {
      const m = byId(f.mail.id);
      if (f.mail.state !== 'picked') return true;
      if (!m) this.picked.add(String(f.mail.id)); // picked up before the put's answer came
      else if (m.state === 'waiting') m.state = 'thinking';
    } else if (f.doing) {
      // An act the agent began after it picked up a message: the newest open message's.
      const m = [...this.messages].reverse().find((x) => OPEN.has(x.state));
      if (!m) return true;
      m.state = 'doing';
      m.act = { verb: str(f.doing.verb) ?? '?', phase: str(f.doing.phase) ?? '?', outcome: str(f.doing.outcome) };
    } else if (f.close) {
      const m = byId(f.close.id);
      if (!m) return true;
      m.state = f.close.state === 'done' ? 'done' : 'failed';
      m.outcome = str(f.close.outcome);
    } else return false;
    this.onChange();
    return true;
  }
}

/** A message's line of what is being done, as plain text. */
export function line(m: Message): string {
  const act = m.act ? `${m.act.verb} ${m.act.phase}${m.act.outcome ? ` (${m.act.outcome})` : ''}` : '';
  switch (m.state) {
    case 'sending': return 'sending…';
    case 'waiting': return 'waiting for your agent';
    case 'thinking': return 'thinking…';
    case 'doing': return act;
    case 'done':
    case 'failed': return [m.state, m.act?.verb, m.outcome].filter(Boolean).join(' · ');
    case 'refused': return `not sent: ${m.outcome}`;
  }
}

/** What the box needs of the page's view socket. */
export type BoxSocket = { sendText(text: string): boolean; onText: ((text: string) => void) | null };

/**
 * Mounts the box for `grant` (a Soul's, or a world's creator's) on the page: a field to write in, and each message with
 * its line. `title` names whose agent it writes to, as the page knows it (a Soul's name may come after the box).
 */
export function mountOwnerBox(sock: BoxSocket, grant: string, title: () => string): OwnerBox {
  const box = new OwnerBox();
  const el = document.createElement('form');
  el.setAttribute('aria-label', 'Write to your agent');
  el.style.cssText = 'position:fixed;left:12px;bottom:12px;width:min(340px,calc(100vw - 24px));padding:10px 12px;box-sizing:border-box;'
    + 'background:rgba(16,20,26,0.9);color:#e8e6e1;font:13px/1.45 system-ui,sans-serif;border-radius:6px;z-index:5';
  const head = document.createElement('div');
  head.style.cssText = 'margin:0 0 6px;color:#9fb3c4;font-size:12px';
  const list = document.createElement('ol');
  list.style.cssText = 'margin:0 0 6px;padding:0;list-style:none;max-height:30vh;overflow:auto';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px';
  const input = document.createElement('input');
  input.name = 'words';
  input.maxLength = WORDS_MOST;
  input.placeholder = 'Write to your agent';
  input.autocomplete = 'off';
  input.style.cssText = 'flex:1;min-width:0;padding:6px 8px;border-radius:4px;border:1px solid #445;background:#0d1015;color:inherit;font:inherit';
  const send = document.createElement('button');
  send.type = 'submit';
  send.textContent = 'Send';
  send.style.cssText = 'padding:6px 10px;border-radius:4px;border:0;background:#3a6ea5;color:#fff;font:inherit;cursor:pointer';
  row.append(input, send);
  el.append(head, list, row);
  document.body.append(el);
  const draw = () => {
    head.textContent = title();
    list.replaceChildren(...box.messages.slice(-5).map((m) => {
      const li = document.createElement('li');
      li.style.cssText = 'margin:0 0 4px';
      const words = document.createElement('div');
      words.textContent = `“${m.words}”`;
      const doing = document.createElement('div');
      doing.dataset.state = m.state;
      doing.style.cssText = 'color:#9fb3c4;font-size:12px';
      doing.textContent = line(m);
      li.append(words, doing);
      return li;
    }));
  };
  box.onChange = draw;
  sock.onText = (t) => void box.text(t);
  el.addEventListener('submit', (e) => {
    e.preventDefault();
    const frame = box.put(grant, input.value);
    if (!frame) return;
    if (!sock.sendText(frame)) box.text(JSON.stringify({ sent: { refused: 'not-connected' } }));
    input.value = '';
  });
  draw();
  setInterval(() => (head.textContent = title()), 2000);
  return box;
}
