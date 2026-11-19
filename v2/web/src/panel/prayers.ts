// The prayers waiting for the creator (Engine v2 G11, #3335), today's `Prayers.tsx` carried into W5's panel. On the
// creator's own socket: `{"prayers": {"n"}}` lists the waiting ones and `{"answer": {"n", "id", "text"}}` answers one,
// each replied to as a text frame `{"reply": {"n", "ok", ..}}` (the directory's, through the gateway; `refused` a name).
// The list is the same mailbox the creator's agent reads; the answer reaches the Soul's `wait`.

/** One prayer, as the directory lists it. */
export type Prayer = { id: string; soul: string; text: string; at: number; state: 'waiting' | 'answered'; answer: string | null };
/** A reply to one request. */
export type Reply = { n: number; ok: boolean; refused?: string; prayers?: Prayer[]; prayer?: Prayer };

/** The longest answer, in characters (the directory refuses longer by name). */
export const ANSWER_MOST = 4000;
/** How often the list is read again, as today's panel does. */
export const EVERY_MS = 10_000;
const REPLY_WITHIN = 10_000;

export class Prayers {
  waiting: Prayer[] = [];
  private n = 0;
  private readonly asked = new Map<number, (r: Reply) => void>();
  private readonly sock: { send(t: string): void };
  onChange: () => void = () => {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(sock: { send(t: string): void }) {
    this.sock = sock;
  }

  /** A text frame from the gateway; true if it was a reply to one of these requests. */
  text(t: string): boolean {
    let f: { reply?: Reply };
    try { f = JSON.parse(t) as { reply?: Reply }; } catch { return false; }
    const r = f.reply;
    if (!r || !this.asked.has(r.n)) return false;
    this.asked.get(r.n)!(r);
    this.asked.delete(r.n);
    return true;
  }

  /** Polls only while this creator socket is open. */
  start(): void {
    if (this.closed || this.timer !== null) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), EVERY_MS);
  }

  /** Closes this socket's polling and settles its pending requests. */
  stop(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const [n, reply] of this.asked) reply({ n, ok: false, refused: 'prayer.unanswered' });
    this.asked.clear();
  }

  private ask(kind: 'prayers' | 'answer', body: object): Promise<Reply> {
    const n = ++this.n;
    if (this.closed) return Promise.resolve({ n, ok: false, refused: 'prayer.unanswered' });
    return new Promise((ok) => {
      const t = setTimeout(() => { this.asked.delete(n); ok({ n, ok: false, refused: 'prayer.unanswered' }); }, REPLY_WITHIN);
      const reply = (r: Reply) => { clearTimeout(t); this.asked.delete(n); ok(r); };
      this.asked.set(n, reply);
      try { this.sock.send(JSON.stringify({ [kind]: { n, ...body } })); }
      catch { reply({ n, ok: false, refused: 'prayer.unanswered' }); }
    });
  }

  /** Reads the waiting prayers again. */
  async refresh(): Promise<void> {
    const r = await this.ask('prayers', { all: false });
    if (!r.ok) return;
    this.waiting = (r.prayers ?? []).filter((p) => p.state === 'waiting');
    this.onChange();
  }

  /** Answers prayer `id`; the refusal's name, or null once it is answered. */
  async answer(id: string, text: string): Promise<string | null> {
    const words = text.trim();
    if (!words) return 'answer.empty';
    if ([...words].length > ANSWER_MOST) return 'answer.too-long';
    const r = await this.ask('answer', { id, text: words });
    if (!r.ok) return r.refused ?? 'answer.refused';
    await this.refresh();
    return null;
  }
}

/** What the panel says for a refusal. */
export function prayerRefusal(name: string): string {
  return ({
    'answer.too-long': `An answer is at most ${ANSWER_MOST.toLocaleString('en')} characters.`,
    'answer.empty': 'Write an answer first.',
    'prayer.not-found': 'That prayer is no longer there.',
    'prayer.unanswered': 'The answer did not reach the world. Try again.',
  } as Record<string, string>)[name] ?? `The world refused it: ${name}.`;
}
