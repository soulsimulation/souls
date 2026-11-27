// #5006 row 4: the pairing card's words for what the agent asks. A creator's agent (`souls-god pair --creator`, the
// directory's `scope: "creator"`) asks to build the world as its creator, not to act as a Soul, and the card says so.
export type PairWords = {
  /** The card's heading. */
  heading: string;
  /** The warning under it. */
  warn: string;
  /** The term of the row that says what is asked ("Soul" for a Soul's request). */
  term: string;
  /** That row's value, or null for a Soul's (the card names the Soul). */
  what: string | null;
  /** What the card says once approved. */
  approved: string;
};

const CHECK = 'Approve only if you started this yourself, on a machine you control, and the code below matches the code on your own screen.';

/** The card's words for a request of `scope` (the directory's `/v1/pair/show` answer). */
export function pairWords(scope: unknown): PairWords {
  if (scope === 'creator') {
    return {
      heading: 'An agent is asking to build your world as its creator',
      warn: `${CHECK} Anyone who sent you this link can be asking to change your world.`,
      term: 'Asks for',
      what: 'your world, as its creator: to place, move and remove things, and to set its weather and sky',
      approved: 'Approved. The agent can now build your world as its creator.',
    };
  }
  return {
    heading: 'A device is asking to act as your Soul',
    warn: `${CHECK} Anyone who sent you this link can be asking for your Soul.`,
    term: 'Soul',
    what: null,
    approved: 'Approved. The device now holds your Soul.',
  };
}
