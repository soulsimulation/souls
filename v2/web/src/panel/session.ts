// The creator's socket for the panel (W5, #2801): the gateway's socket (I1) signed in with the token the session
// exchange gave (`POST /v2/creator-token`, gatewayd's `creator.rs`). The order is the gateway's: T10's first frame each
// way, then the sign-in by message (a browser cannot set headers), then its outcome, then edits in and answers out.
// Every change the panel makes is an edit intent sent here; `sent` counts them.
import { editIntent, readFrame, sequenceOf, ZERO, type Frame, type IdValue, type Op, type Version } from './edit.ts';

/** What the session needs of a socket: a browser WebSocket in the page, a stand-in in tests. */
export type Sock = { send(b: Uint8Array): void };

export class CreatorSession {
  /** Edit intents sent on this socket. */
  sent = 0;
  /** The newest version an answer carried: what the next edit is planned against. */
  latest: Version = ZERO;
  state: 'hello' | 'signing-in' | 'open' | 'refused' = 'hello';
  outcome = '';
  private next: number;
  private readonly waiting = new Map<number, (f: Frame) => void>();
  private readonly sock: Sock;
  private readonly creator: IdValue;
  private readonly signIn: Uint8Array;
  onOpen: () => void = () => {};

  /** `hello` and `signIn` are the first frame and the sign-in's bytes (replica's `wireHello`, `wireSignIn`). A
   * sequence is per actor and never reused, so the first is after any an earlier page sent: `first`, from the time. */
  constructor(sock: Sock, creator: IdValue, hello: Uint8Array, signIn: Uint8Array, first: number) {
    this.sock = sock;
    this.creator = creator;
    this.signIn = signIn;
    this.next = first;
    sock.send(hello);
  }

  /** One binary frame from the gateway. */
  frame(b: Uint8Array): void {
    if (this.state === 'hello') {
      this.state = 'signing-in';
      this.sock.send(this.signIn);
      return;
    }
    const f = readFrame(b);
    if (f.t === 'outcome') {
      this.outcome = f.name;
      this.state = f.name.startsWith('stream.') ? 'open' : 'refused';
      if (this.state === 'open') this.onOpen();
      return;
    }
    if (f.t !== 'receipt' && f.t !== 'refused') return;
    if (sequenceOf(f.version) > sequenceOf(this.latest)) this.latest = f.version!;
    this.waiting.get(f.sequence)?.(f);
    this.waiting.delete(f.sequence);
  }

  /** Sends one edit of `ops`; its answer, when the world gives it. */
  edit(ops: Op[]): Promise<Frame> {
    if (this.state !== 'open') return Promise.reject(new Error('the creator is not signed in'));
    const sequence = this.next++;
    this.sock.send(editIntent(this.creator, sequence, this.latest, ops));
    this.sent++;
    return new Promise((resolve) => this.waiting.set(sequence, resolve));
  }
}
