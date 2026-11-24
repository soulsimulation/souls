// R4 (0.134): `souls-god recolor <id> '#rrggbb' [--part <part>]`, a creator's tint on a thing or one of its named parts.
// The tint is one field of the thing (replica `tint::F_TINT`): rows `[part, rgb]`, `tint:whole` for the whole thing and
// `part:<name>` for a part. The command reads the field from the daemon's copy, replaces or adds the one row, and sends
// the whole field as one set, so the world checks it (`edit.tint-malformed`) and only its creator may write it; undo
// takes it back.

/** The tint field on a thing's node (replica `tint::F_TINT`), and the row's part for the whole thing. */
export const F_TINT = 145, WHOLE = 'tint:whole';
const PART = /^[a-z][a-z0-9_-]{0,63}$/;
const usage = (detail) => Object.assign(new Error(detail), { code: 'usage' });
const HOW = "recolor <id> '#rrggbb' [--part <part>]";

/** `{ node, rgb, part }` from the verb's words; `part` is the row's part text (`tint:whole` or `part:<name>`). */
export function recolorOf(words) {
  const args = [...words];
  const at = args.indexOf('--part');
  let part = WHOLE;
  if (at >= 0) {
    const name = String(args[at + 1] ?? '').toLowerCase();
    args.splice(at, 2);
    if (!PART.test(name)) throw usage(`${HOW}: a part is a name (letters, digits, _ and -)`);
    part = `part:${name}`;
  }
  if (args.length !== 2 || !/^#?[0-9a-f]{6}$/i.test(args[1])) throw usage(HOW);
  return { node: /^\d+$/.test(args[0]) ? Number(args[0]) : args[0], rgb: parseInt(args[1].replace('#', ''), 16), part };
}

/** The tint's rows with `part` set to `rgb`: the whole thing first, then each part by name, so a tint is written the
 *  same way however it was reached. Rows that do not read are left out. */
export function tintRows(held, part, rgb) {
  const rows = (Array.isArray(held) ? held : []).filter((r) => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && Number.isInteger(r[1]) && r[0] !== part);
  const key = (r) => (r[0] === WHOLE ? '' : r[0]);
  return [...rows, [part, rgb]].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** `#rrggbb` for a colour as the field holds it. */
export const hex = (rgb) => '#' + Number(rgb).toString(16).padStart(6, '0');

/** Runs a recolour through the daemon: reads the thing's tint from its copy, then sends the one set. Answers the
 *  edit's answer with the tint it leaves, by part (`*` the whole thing). */
export async function runRecolor(r, ask) {
  const f = await ask({ op: 'fields', node: r.node });
  if (f.ok === false) return f;
  const rows = tintRows(f.fields?.[String(F_TINT)], r.part, r.rgb);
  const out = await ask({ op: 'edit', ops: [{ op: 'set', node: r.node, field: F_TINT, value: rows }] });
  return out.ok === false ? out : { ...out, tint: Object.fromEntries(rows.map(([p, c]) => [p === WHOLE ? '*' : p.slice(5), hex(c)])) };
}
