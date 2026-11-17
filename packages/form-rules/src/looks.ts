// How a thing looks in each state, as data and one plain function (Soul Actions SA-D1a, #2885).
//
// A kind's `looks.table` is a list of rows. A row says: this state field moves this part this way. `looks(input)` turns
// the table, a state and (optionally) the time since the state changed into the placement of each named part. The same
// input gives the same answer in Node and in any browser build; the viewer, not this file, turns millidegrees,
// millimetres and permille into the numbers its renderer wants.
//
// Rules this file keeps (the same as rules.ts): no imports, plain data in and out, whole numbers only (no floating
// point reaches an answer; division truncates toward zero on exact integers), loops over what the table declares.
// Collision shapes never follow looks: nothing here reads or writes geometry, only the picture's parts.
//
// A row:   { part, field, do, axis?, at? | range+to, over_us? }
//   do      rotate  mdeg about axis x|y|z          slide  mm along axis x|y|z
//           scale   permille (1000 = as built), axis x|y|z or omitted for all three
//           show    1 shown, 0 hidden              glow   permille of the part's own glow
//           tint    a colour "#rrggbb" (named by at)
//           pick    no `part`: at maps a field value to the part shown; every other part named in at is hidden
//   at      a table of field value (as text: "true", "hot", "3") to the amount; for bool and enum fields
//   range   [min, max] whole numbers of a number field, with `to` [amount at min, amount at max]: linear between,
//           clamped outside. A fractional field is carried in permille, so a half-full cup is 500.
//   over_us the part takes this long, in microseconds, to get from the amount of the previous state to this one
//
// Names (parts, picks) keep to letters, digits and _ - . : / @ so Engine v2's encoding accepts them.

export const DOS = Object.freeze(['rotate', 'slide', 'scale', 'show', 'glow', 'tint', 'pick']);
export const AXES = Object.freeze(['x', 'y', 'z']);
/** What Engine v2's encoding accepts in a name. */
export const NAME = /^[A-Za-z0-9_\-.:/@]+$/;
export const MAX_ROWS = 64;

export type Value = boolean | number | string;
export type LookRow = {
  part?: string;
  field: string;
  do: string;
  axis?: string;
  at?: Record<string, number | string>;
  range?: [number, number];
  to?: [number | string, number | string];
  over_us?: number;
};
export type Placement = {
  show?: boolean;
  rotate_mdeg?: [number, number, number];
  slide_mm?: [number, number, number];
  scale_permille?: [number, number, number];
  glow_permille?: number;
  tint?: string;
};
export type LooksInput = {
  table: LookRow[];
  state: Record<string, Value>;
  /** The state before the last change, and the microseconds since it changed: only rows with `over_us` use them. */
  prev?: Record<string, Value>;
  t_us?: number;
};

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const COLOUR = /^#[0-9a-fA-F]{6}$/;

/** Everything wrong with a table, as readable lines (none: the table is fine). `fields` are the kind's state fields, when known. */
export function checkTable(table: unknown, fields?: Record<string, { type?: string; values?: string[]; min?: number; max?: number }>): string[] {
  const errs: string[] = [];
  if (!Array.isArray(table)) return ['looks.table is a list of rows'];
  if (table.length > MAX_ROWS) errs.push(`looks.table has more than ${MAX_ROWS} rows`);
  table.forEach((r, i) => {
    const p = `looks.table.${i}`;
    if (!isObj(r)) return void errs.push(`${p}: a row is an object`);
    for (const k of Object.keys(r)) if (!['part', 'field', 'do', 'axis', 'at', 'range', 'to', 'over_us'].includes(k)) errs.push(`${p}.${k}: not a looks field`);
    if (!DOS.includes(r.do as string)) errs.push(`${p}.do: one of ${DOS.join(', ')}`);
    if (typeof r.field !== 'string' || (fields && !(r.field in fields))) errs.push(`${p}.field: names a state field of the kind`);
    if (r.do === 'pick') { if (r.part !== undefined) errs.push(`${p}.part: a pick names its parts in at`); }
    else if (typeof r.part !== 'string' || !NAME.test(r.part)) errs.push(`${p}.part: a name of letters, digits and _ - . : / @`);
    if (r.axis !== undefined && !AXES.includes(r.axis as string)) errs.push(`${p}.axis: one of ${AXES.join(', ')}`);
    if ((r.do === 'rotate' || r.do === 'slide') && r.axis === undefined) errs.push(`${p}.axis: ${r.do} needs an axis`);
    if (r.over_us !== undefined && !(isInt(r.over_us) && r.over_us > 0)) errs.push(`${p}.over_us: whole microseconds above zero`);
    const f = typeof r.field === 'string' ? fields?.[r.field] : undefined;
    const amount = (v: unknown, w: string) => {
      if (r.do === 'tint') { if (typeof v !== 'string' || !COLOUR.test(v)) errs.push(`${w}: a colour #rrggbb`); }
      else if (r.do === 'pick') { if (typeof v !== 'string' || !NAME.test(v)) errs.push(`${w}: a part name of letters, digits and _ - . : / @`); }
      else if (!isInt(v)) errs.push(`${w}: a whole number`);
      else if (r.do === 'show' && v !== 0 && v !== 1) errs.push(`${w}: 0 or 1`);
    };
    if (r.at !== undefined) {
      if (r.range !== undefined || r.to !== undefined) errs.push(`${p}: at, or range with to, not both`);
      if (!isObj(r.at) || Object.keys(r.at).length === 0) errs.push(`${p}.at: a table of field value to amount`);
      else for (const [k, v] of Object.entries(r.at)) {
        amount(v, `${p}.at.${k}`);
        if (f?.type === 'enum' && !f.values?.includes(k)) errs.push(`${p}.at.${k}: not a value of ${r.field}`);
        if (f?.type === 'bool' && k !== 'true' && k !== 'false') errs.push(`${p}.at.${k}: true or false`);
      }
    } else if (r.do === 'pick') errs.push(`${p}.at: a pick maps field values to parts`);
    else {
      const rg = r.range as unknown, to = r.to as unknown;
      if (!Array.isArray(rg) || rg.length !== 2 || !rg.every(isInt) || !(rg[0] < rg[1])) errs.push(`${p}.range: [min, max], whole numbers, min below max`);
      if (!Array.isArray(to) || to.length !== 2) errs.push(`${p}.to: [amount at min, amount at max]`);
      else { amount(to[0], `${p}.to.0`); amount(to[1], `${p}.to.1`); }
      if (r.do === 'pick') errs.push(`${p}: a pick uses at`);
      if (f && f.type !== 'int' && f.type !== 'number') errs.push(`${p}.field: range needs a number field; use at for ${f.type}`);
    }
  });
  return errs;
}

/** a + (b - a) * num / den, whole numbers, truncated toward zero. */
function lerp(a: number, b: number, num: number, den: number): number {
  const n = (b - a) * num;
  return a + (n - (n % den)) / den;
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The amount a row gives for a state, or undefined when the field is unset or no `at` entry covers its value. */
function amountOf(row: LookRow, state: Record<string, Value>): number | string | undefined {
  const v = state[row.field];
  if (v === undefined) return undefined;
  if (row.at) return row.at[String(v)];
  if (!isInt(v) || !row.range || !row.to) return undefined;
  const [lo, hi] = row.range, [a, b] = row.to;
  const t = clamp(v, lo, hi) - lo;
  if (typeof a === 'string' || typeof b === 'string') return t * 2 < hi - lo ? a : b;
  return lerp(a, b, t, hi - lo);
}

/** Where each part is for this state (and, with `prev` and `t_us`, part-way there). A part no row names is not in the answer. */
export function looks(input: LooksInput): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  const part = (name: string) => (out[name] ??= {});
  const at = (row: LookRow): number | string | undefined => {
    const now = amountOf(row, input.state);
    if (now === undefined || !row.over_us || !input.prev || input.t_us === undefined || typeof now !== 'number') return now;
    const was = amountOf(row, input.prev);
    if (typeof was !== 'number') return now;
    return lerp(was, now, clamp(input.t_us, 0, row.over_us), row.over_us);
  };
  for (const row of input.table) {
    if (row.do === 'pick') {
      // a state with no matching choice shows none of the parts the row names
      const chosen = input.state[row.field] === undefined ? undefined : row.at?.[String(input.state[row.field])];
      if (input.state[row.field] === undefined) continue;
      const shown = typeof chosen === 'string' ? chosen : undefined;
      for (const name of new Set(Object.values(row.at ?? {}).filter((x): x is string => typeof x === 'string'))) {
        const p = part(name);
        p.show = (p.show ?? true) && name === shown;
      }
      continue;
    }
    const amount = at(row);
    if (amount === undefined || !row.part) continue;
    const p = part(row.part), k = row.axis ? AXES.indexOf(row.axis) : -1;
    if (row.do === 'show') p.show = (p.show ?? true) && amount !== 0;
    else if (row.do === 'glow' && typeof amount === 'number') p.glow_permille = amount;
    else if (row.do === 'tint' && typeof amount === 'string') p.tint = amount;
    else if (row.do === 'rotate' && typeof amount === 'number' && k >= 0) (p.rotate_mdeg ??= [0, 0, 0])[k] += amount;
    else if (row.do === 'slide' && typeof amount === 'number' && k >= 0) (p.slide_mm ??= [0, 0, 0])[k] += amount;
    else if (row.do === 'scale' && typeof amount === 'number') {
      const s = (p.scale_permille ??= [1000, 1000, 1000]);
      for (const j of k >= 0 ? [k] : [0, 1, 2]) { const n = s[j] * amount; s[j] = (n - (n % 1000)) / 1000; }
    }
  }
  return out;
}
