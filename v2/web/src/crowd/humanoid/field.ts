// Where a humanoid look rides on a Soul (#3998): the body node's field 33 holds the look's core/humanoid@2 params as
// UTF-8 JSON (today's compact `params`, at most 2 KiB). It is a costume over the default body: the page draws it only
// while the node has no body hash (field 32), and draws the default body while the look loads or if it cannot be drawn.
// No import here, so both stream workers can read it.

/** The body node's field holding its humanoid look's params. */
export const LOOK_FIELD = 33;
/** The crowd's body key for a look: this prefix, then the params' JSON. */
export const LOOK_PREFIX = 'humanoid2:';
const MAX_BYTES = 2048;

/** The look's params as JSON text, or undefined when the field is not a look's shape. */
export function lookOf(value: unknown): string | undefined {
  if (!(value instanceof Uint8Array) || value.length > MAX_BYTES) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value), params = JSON.parse(text) as unknown;
    return params && typeof params === 'object' && !Array.isArray(params) ? text : undefined;
  } catch { return undefined; }
}

/** The crowd's body key for a node: its body hash, else its look, else none (the default body). */
export function bodyKey(body: string | undefined, look: string | undefined): string | undefined {
  return body ?? (look === undefined ? undefined : LOOK_PREFIX + look);
}
