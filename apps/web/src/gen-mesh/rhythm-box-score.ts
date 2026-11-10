/** Three independent eight-step percussion lanes, on the existing depicted world beat. */
export function rhythmBoxHits(state: Record<string, unknown>, from: number, to: number) {
  const tempo = Number(state.tempo);
  if (state.on !== true || ![60, 90, 120].includes(tempo) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 2) return [];
  const stepSeconds = 60 / tempo;
  const hits: { t: number; kind: string; step: number }[] = [];
  for (let k = Math.ceil(from / stepSeconds); k * stepSeconds < to; k++) {
    const step = ((k % 8) + 8) % 8;
    for (const kind of ['kick', 'snare', 'hat']) {
      const mask = Number(state[kind]);
      if (Number.isInteger(mask) && mask >= 0 && mask <= 255 && (mask & (1 << step))) hits.push({ t: k * stepSeconds, kind, step });
    }
  }
  return hits;
}
