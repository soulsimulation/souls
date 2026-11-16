// Clip kit (#2617, measurement branch only): Broadcast at 50 Souls. Fifty raw fake-mind Souls join the clip's Eden 2026
// dev world (as the page harness's, tools/test-harness/page-souls.mjs) and walk to the bandstand; most stay gathered, a
// few walk elsewhere and some speak while the take runs. The page is the default Broadcast camera; the take shows its
// shots at real speed, and the in-page frame times (requestAnimationFrame deltas) and the director's own cost per frame
// are written to the clip log at the end.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { CLIP_WORLD, CLIP_CHECKOUT = '.' } = process.env;
const SOULS = 50;
const imp = (p) => import(pathToFileURL(join(CLIP_CHECKOUT, p)).href);
const { rawJoin, wordIds } = await imp('tools/playtest/eval/load.mjs');
const cs = await imp('tools/bench/capacity/meetup/client-soul.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const souls = [];
for (let i = 0; i < SOULS; i += 8) await Promise.all(Array.from({ length: Math.min(8, SOULS - i) }, async (_, j) => { souls[i + j] = await rawJoin(CLIP_WORLD, i + j); }));
let cat = null;
for (let k = 0; !cat && k < 30; k++) { cat = (await cs.startPicture(CLIP_WORLD, souls[0])).catalog; if (!cat) await sleep(2000); }
const ids = cs.catalogIds(cat), named = wordIds(cat), meet = named.bandstand?.length ? named.bandstand : ids.walk.slice(0, 1);
const act = (s, id, n) => { const key = `kit-${s.i}-${n}-${Date.now()}`; return cs.clientCall(`${CLIP_WORLD}/v1/edge/act`, { method: 'POST', headers: cs.clientHeaders(s, { key }), body: cs.actBody(id, key) }); };
let walked = 0;
await Promise.all(souls.map(async (s) => { const r = await act(s, s.i % 10 < 8 ? meet[s.i % meet.length] : ids.walk[s.i % ids.walk.length], 0); if (r.status === 200 || r.status === 202) walked++; }));
console.error(`kit: ${souls.length} Souls joined; ${walked} first walks accepted (meet ${meet[0]})`);
let live = true;
const chatter = (async () => { for (let n = 1; live; n++) { await sleep(3000); const s = souls[(n * 7) % souls.length];
  await cs.clientCall(`${CLIP_WORLD}${cs.SAY_PATH}`, { method: 'POST', headers: cs.clientHeaders(s, { key: `kit-say-${n}` }), body: cs.sayBody(`Hello from ${s.i} at the bandstand.`) }).catch(() => {});
  if (n % 3 === 0) await act(souls[(n * 11) % souls.length], ids.walk[n % ids.walk.length], n).catch(() => {}); } })();

export default async function steps(page, { mark }) {
  mark('Broadcast, 50 Souls');
  await page.evaluate(() => { const P = window.__kitFrames = { t: [] }; const f = (t) => { P.t.push(t); requestAnimationFrame(f); }; requestAnimationFrame(f); window.__soulsBroadcastParts?.(true); });
  await page.waitForTimeout(45_000);
  const d = await page.evaluate(() => { const t = window.__kitFrames.t, iv = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b), q = (p) => iv.length ? +iv[Math.min(iv.length - 1, Math.ceil(iv.length * p) - 1)].toFixed(1) : null;
    return { frames: iv.length, p50: q(.5), p95: q(.95), over33: iv.filter((x) => x > 1000 / 30).length, shot: document.querySelector('canvas[data-camera-shot]')?.dataset.cameraShot ?? null, director: window.__soulsBroadcastParts?.() ?? null }; });
  console.error(`kit: frames ${JSON.stringify(d)}`);
  mark(`frame p50 ${d.p50} ms`);
  live = false; await chatter.catch(() => {});
  await page.waitForTimeout(1000);
}
