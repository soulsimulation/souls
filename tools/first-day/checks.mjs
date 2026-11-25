// Explicit checks on the page's own state, the secondary signal beside the screenshots. Every input is a snapshot that
// `pageState` (page.mjs) read from the page: what the page itself draws from, never what the agent or a client says.

/** Text on the page that means the world or the Soul is not working. */
export const BAD_BANNERS = [/stream is not available/i, /could not be prepared/i, /cannot open right now/i, /View unavailable/i, /Reconnecting/i,
  /not available/i, /frozen/i, /something went wrong/i];

const dist2 = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : null);

/** The person's Soul in a snapshot: by id, else by name. */
export function mine(state, { id = null, name = null } = {}) {
  const souls = state?.souls ?? [];
  return souls.find((s) => id && s.id === id) ?? souls.find((s) => name && s.name && s.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** The checks every step gets, then the step's own (`step.checks`). → [{check, ok, detail, severity}] */
export function checkStep(step, { before, after, trail = [], soul, consoleErrors = [] }) {
  const out = [], add = (check, ok, detail, severity = 'major') => out.push({ check, ok: !!ok, detail, severity });
  const b = mine(before, soul), a = mine(after, soul);
  const banners = BAD_BANNERS.filter((r) => r.test(after?.text ?? '')).map(String);
  add('no-bad-banner', !banners.length, banners.length ? `on the page: ${banners.join(', ')}` : 'none', 'major');
  add('no-console-errors', !consoleErrors.length, consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ').slice(0, 300) : 'none', 'minor');
  if (!soul) return out;
  add('soul-visible', !!a?.p, a?.p ? `at ${a.p.map((v) => v.toFixed(1)).join(', ')}` : 'my Soul is not in the page\'s picture', 'blocker');
  add('soul-named', !!a?.name, a?.name ? `named ${a.name}` : 'no name', 'major');
  for (const c of step.checks ?? []) {
    if (c === 'moved') {
      // the farthest it got from where it started, up and down too: a Soul that goes upstairs, or around a building and
      // back, moved even when it ends above or at its starting spot
      const ds = [a, ...trail.map((t) => mine(t, soul))].filter((s) => s?.p && b?.p).map((s) => Math.hypot(s.p[0] - b.p[0], s.p[1] - b.p[1], s.p[2] - b.p[2]));
      const d = ds.length ? Math.max(...ds) : null;
      add('moved', d != null && d > 1.5, d == null ? 'no position' : `got ${d.toFixed(1)} m from where it started`);
    }
    if (c === 'far') { const d = dist2(b?.p, a?.p); add('far', d != null && d > 25, d == null ? 'no position' : `${d.toFixed(1)} m from the start`); }
    if (c === 'near' && step.near) { const d = a?.p ? Math.hypot(a.p[0] - step.near[0], a.p[2] - step.near[1]) : null; add('near-target', d != null && d < 8, d == null ? 'no position' : `${d.toFixed(1)} m from it`); }
    if (c === 'seated') { const any = [a, ...trail.map((t) => mine(t, soul))].some((s) => s?.doing === 'seated' || s?.seatHeight != null); add('seated', any, `doing ${a?.doing ?? '?'}, seat ${a?.seatHeight ?? 'none'}`); }
    if (c === 'spoke') { const said = [after, ...trail].flatMap((t) => t?.speech ?? []).filter((w) => w.soul === a?.id || w.who === a?.name); const doing = [a, ...trail.map((t) => mine(t, soul))].some((s) => s?.doing === 'speaking'); add('spoke', said.length || doing, said.length ? `said "${String(said.at(-1).text ?? '').slice(0, 80)}"` : (doing ? 'speaking' : 'no words from my Soul')); }
    if (c === 'held') { const held = [a, ...trail.map((t) => mine(t, soul))].find((s) => s?.prop); add('held-item', !!held, held ? `holding ${held.prop}` : 'nothing in hand'); }
    if (c === 'rose') { const top = Math.max(...[a, ...trail.map((t) => mine(t, soul))].filter((s) => s?.p).map((s) => s.p[1])); add('rose', b?.p && top - b.p[1] > 2, b?.p ? `highest ${(top - b.p[1]).toFixed(1)} m above the start` : 'no position'); }
    if (c === 'activity') { const acts = [...new Set([a, ...trail.map((t) => mine(t, soul))].map((s) => s?.activity).filter((x) => x && !['idle', 'walk', 'posture'].includes(x)))]; add('activity', acts.length, acts.length ? acts.join(', ') : `only ${[...new Set(trail.map((t) => mine(t, soul)?.activity))].join(', ') || 'nothing'}`); }
    if (c === 'facing' && step.near && a?.p && a.yaw != null) {
      // yaw is a heading from atan2(dz, dx) (apps/web/src/v2-engine/takes.ts)
      const want = Math.atan2(step.near[1] - a.p[2], step.near[0] - a.p[0]), off = Math.abs(Math.atan2(Math.sin(a.yaw - want), Math.cos(a.yaw - want)));
      add('facing', off < Math.PI / 3, `${Math.round(off * 180 / Math.PI)} degrees off the target`, 'minor');
    }
  }
  return out;
}

/** The checks after approval (playbook step 6). */
export function arrivalChecks(state, soul) {
  const out = [], add = (check, ok, detail, severity = 'major') => out.push({ check, ok: !!ok, detail, severity });
  const s = mine(state, soul);
  add('soul-in-world', !!s?.p, s?.p ? `at ${s.p.map((v) => v.toFixed(1)).join(', ')}` : 'not in the page\'s picture', 'blocker');
  add('soul-named', !!s?.name, s?.name ?? 'no name', 'major');
  add('in-navbar', (state?.navbar ?? []).some((l) => s?.name && l.includes(s.name)), (state?.navbar ?? []).length ? state.navbar.join(', ') : 'the navbar lists no Souls of yours', 'major');
  const cam = state?.camera?.pivot, d = s?.p && cam ? Math.hypot(cam[0] - s.p[0], cam[2] - s.p[2]) : null;
  add('camera-on-soul', state?.chip?.followSoul === s?.id || (d != null && d < 10), d != null ? `camera ${d.toFixed(1)} m from it${state?.chip?.camera ? `, chip ${state.chip.camera}` : ''}` : 'no camera reading', 'major');
  add('card-connected', state?.card?.statusKey === 'connected', state?.card ? `card: ${state.card.name ?? '?'} / ${state.card.status ?? 'no status'}` : 'no card open', 'major');
  return out;
}

/** A finding, written as text ready to file as a task. */
export function finding({ step, title, expected, seen, screenshot, severity, repro }) {
  return { step, title, expected, seen, screenshot, severity, repro };
}
