// Engine v2 V14 (#2659): the steps for recording the bird's-eye view with the proof recorder, uncut at real speed.
// From the repository root, with the trace `cargo run -p birdseye --release -- ../.local/birdseye/run.trace` wrote:
//   BIRDSEYE_TRACE=$PWD/.local/birdseye/run.trace node .claude/skills/proof/record.mjs --from-load \
//     --url "file://$PWD/v2/tools/birdseye/view.html" --steps v2/tools/birdseye/record-steps.mjs --max-seconds 640 \
//     --out .local/birdseye/birdseye.mp4
// The trace is chosen in the page's file input (the one step a recorder cannot click through), then the run is played
// with clicks: Play, floor 1 for eight seconds at one minute, back to floor 0, and the whole run watched to its end.
export default async (page, { mark }) => {
  const trace = process.env.BIRDSEYE_TRACE;
  if (!trace) throw new Error('set BIRDSEYE_TRACE to the trace file');
  await page.setInputFiles('#file', trace);
  await page.locator('#play:not([disabled])').waitFor();
  const seconds = await page.evaluate(() => document.querySelector('#time').textContent);
  mark(`loaded: ${seconds}`);
  const t0 = Date.now();
  await page.locator('#play').click();
  mark('play');
  const until = async (s) => { const ms = t0 + s * 1000 - Date.now(); if (ms > 0) await page.waitForTimeout(ms); };
  await until(60);
  await page.getByRole('button', { name: 'floor 1' }).click();
  mark('floor 1');
  await until(68);
  await page.getByRole('button', { name: 'floor 0' }).click();
  mark('floor 0');
  await until(Number(process.env.BIRDSEYE_SECONDS ?? 600) + 2);
  mark('end');
};
