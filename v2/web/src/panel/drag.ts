// A drag in the creator's panel (W5, #2801): while the pointer is down the page draws a ghost where the thing would go,
// locally, and sends nothing; on release it sends one edit. The ghost is interface, not world state: it moves nothing,
// and the thing stays where the world has it until the world's answer (and its stream) say otherwise. One edit per
// release keeps a drag far inside the gateway's limit on edits a minute.
//
// The local check (`warn`) is advice on the page's copy, which runs behind the world: it names a Soul the ghost would
// land on before release. The world's answer rules: the edit is sent either way.

/** A point on the ground, metres, in the world's frame. */
export type At = { x: number; z: number };
/** A Soul's body as the page's copy has it: its id, its name if known, where it stands. */
export type Body = { id: string; name: string | null; at: At };

/** A body's radius (m) for the page's warning: the world judges with the body's own. */
export const BODY_RADIUS = 0.5;

/** The first Soul whose body `at` falls on, within its radius, or null. */
export function onSoul(at: At, bodies: Body[], radius = BODY_RADIUS): Body | null {
  let best: Body | null = null, d = radius;
  for (const b of bodies) {
    const e = Math.hypot(b.at.x - at.x, b.at.z - at.z);
    if (e <= d) (best = b), (d = e);
  }
  return best;
}

/** How the panel names a Soul: its name, else its id's counter, as the page's chips do. */
export const soulName = (b: Body) => b.name ?? b.id.split('.').pop()!;

/** The build-safety rule's refusals (AGENTS.md, BUILDSAFE): an edit that would bury or cut off a Soul, or change what
 * it uses, is refused, not repaired. */
export const BUILDSAFE = new Set(['edit.would-bury', 'edit.in-use', 'edit.would-cut-off']);

/** A refusal as the panel lists it: the world's name for it and, for a build-safety refusal, the Soul the edit was onto.
 * T10's refusal carries the name alone, so the Soul is the one the page's copy has nearest the edit's spot. */
export function refusalText(reason: string, at: At, bodies: Body[]): string {
  const soul = BUILDSAFE.has(reason) ? onSoul(at, bodies, 3 * BODY_RADIUS) : null;
  return `refused ${reason}${soul ? `: Soul ${soulName(soul)}` : ''}`;
}

export type Ghost ={ id: string; at: At; over: Body | null };

export class Drag {
  /** The ghost while a drag is held: drawn by the page, never sent. */
  ghost: Ghost | null = null;
  private readonly send: (id: string, at: At) => void;
  private readonly bodies: () => Body[];
  constructor(send: (id: string, at: At) => void, bodies: () => Body[]) {
    this.send = send;
    this.bodies = bodies;
  }

  /** The pointer goes down on thing `id`. */
  down(id: string, at: At): void {
    this.ghost = { id, at, over: onSoul(at, this.bodies()) };
  }

  /** The pointer moves: the ghost follows, here only. */
  move(at: At): void {
    if (this.ghost) this.ghost = { ...this.ghost, at, over: onSoul(at, this.bodies()) };
  }

  /** The pointer is released: one edit, to where the ghost is. True if one was sent. */
  up(): boolean {
    const g = this.ghost;
    this.ghost = null;
    if (!g) return false;
    this.send(g.id, g.at);
    return true;
  }

  /** The drag is abandoned (Escape, the pointer lost): nothing is sent. */
  cancel(): void {
    this.ghost = null;
  }
}
