// A view socket for the box alone (Engine v2 W10, #2802): the creator's panel has no body to follow, so it signs in to
// the gateway with a view token (V13b) and subscribes to nothing; it carries only the box's text frames
// (`box.ts`). The owner's page uses the view socket it already has (`SocketSource`). The token is renewed on the open
// socket before it expires, as `SocketSource` does, and never logged or shown.
import { decode } from 'cborg';
import { RENEW_BEFORE_MS, frames } from '../source/socket.ts';
import type { BoxSocket } from './box.ts';

export type MailSocketOptions = {
  /** The gateway's socket, `ws(s)://…/v2/ws`. */
  url: string;
  token: string;
  /** When `token` expires, seconds since 1970, and how to get a fresh one. */
  expires: number;
  renew: () => Promise<{ token: string; expires: number }>;
  WebSocket?: typeof WebSocket;
};

export class MailSocket implements BoxSocket {
  onText: ((text: string) => void) | null = null;
  /** The sign-in's outcome, by name. */
  outcome = '';
  private ws: WebSocket | null = null;
  private open = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  #token: string;
  #expires: number;
  private readonly o: MailSocketOptions;

  constructor(o: MailSocketOptions) {
    this.o = o;
    this.#token = o.token;
    this.#expires = o.expires;
  }

  start(): void {
    if (this.stopped) return;
    if (Date.now() >= this.#expires * 1000 - 1000) {
      // Back after a drop with a token that has lapsed: a fresh one first.
      this.o.renew().then((g) => ((this.#token = g.token), (this.#expires = g.expires), this.connect()),
        () => (this.timer = setTimeout(() => this.start(), 1000)));
      return;
    }
    this.connect();
  }

  private connect(): void {
    const ws = new (this.o.WebSocket ?? globalThis.WebSocket)(this.o.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let step = 0; // 0 hello sent, 1 sign-in sent, 2 open
    ws.onopen = () => ws.send(frames.hello());
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return void this.onText?.(ev.data);
      if (step === 0) return void ((step = 1), ws.send(frames.signIn(this.#token)));
      const m = decode(new Uint8Array(ev.data as ArrayBuffer), { useMaps: true }) as Map<number, unknown>;
      if (typeof m.get(4) === 'string') this.outcome = m.get(4) as string;
      if (step === 1 && this.outcome === 'view.started') (step = 2), (this.open = true), this.renewLater();
    };
    ws.onclose = () => {
      this.open = false;
      this.ws = null;
      if (!this.stopped) this.timer = setTimeout(() => this.start(), 1000);
    };
    ws.onerror = () => ws.close();
  }

  /** A fresh token before this one expires, sent on the open socket. */
  private renewLater(): void {
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(1000, this.#expires * 1000 - Date.now() - RENEW_BEFORE_MS);
    this.timer = setTimeout(async () => {
      try {
        const g = await this.o.renew();
        (this.#token = g.token), (this.#expires = g.expires);
        if (this.open) this.ws?.send(frames.signIn(g.token));
      } catch {
        // kept until it expires; the socket then closes and signs in again
      }
      if (!this.stopped) this.renewLater();
    }, Math.min(wait, 2 ** 31 - 1));
  }

  sendText(text: string): boolean {
    return this.open && this.ws?.readyState === 1 ? (this.ws.send(text), true) : false;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }
}
