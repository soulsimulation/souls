// Actual-page conference composition diagnostic. Receipts/canvas readiness do not qualify animation/contact.
// The unchanged runOwnedAttempt owns the sole native world, all registered clients/commands and the browser.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeCameraMode } from './camera-native-page.mjs';
import { assembleConference, discoverConference, explainConference } from '../../playtest/conference/rehearse.mjs';
import { downloadConferenceClient, pairConferenceSeat, requireConferenceRecipe } from '../../playtest/conference/owned-seats.mjs';

const states = new Map();
const names = ['Presenter', 'Cedar', 'Maple', 'Willow', 'Birch'];
const save = (paths, file, value) => writeFileSync(join(paths.dir, file), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });

export function conferenceFixtures({ lecterns, questions, benches }) {
  assert.equal(lecterns.length, 1, 'conference-proof requires one authored presentation lectern');
  assert.equal(questions.length, 1, 'conference-proof requires one authored question stand');
  assert.equal(benches.length, 2, 'conference-proof requires two authored audience benches');
  return { lecture: lecterns[0].id, question: questions[0].id,
    benches: [...benches].sort((a, b) => a.name.localeCompare(b.name)).map(n => n.id) };
}

export async function prepare({ base, paths, recipe, signal }) {
  requireConferenceRecipe(recipe);
  const state = { paths, signal, rows: [], seats: [] };
  states.set(paths.dir, state);
  state.record = row => state.rows.push({ at: Date.now(), ...row });
  const bundle = await downloadConferenceClient({ base, paths, signal });
  state.seats = await Promise.all(names.map((name, index) => pairConferenceSeat({
    recipe, paths, bundle, label: `conference-${index}`, name, signal,
  })));
  const find = async (words, kind) => {
    const answer = await state.seats[0].cli('find', words);
    state.record({ person: state.seats[0].label, words: ['find', words], answer });
    assert.equal(answer.ok, true, 'conference-proof ordinary fixture discovery');
    return (answer.found ?? []).filter(n => n.kind.split('@')[0] === kind);
  };
  const [lecterns, questions, benches] = await Promise.all([
    find('presentation-lectern', 'eden:hall_lecture'), find('question-stand', 'eden:conference_question'), find('audience', 'eden:bench'),
  ]);
  state.fixtures = conferenceFixtures({ lecterns, questions, benches });
  state.discovery = await discoverConference({ seat: state.seats[0], ...state.fixtures, record: state.record });
  await assembleConference({ seats: state.seats, ...state.fixtures, record: state.record });
  save(paths, 'conference-discovery.json', { fixtures: state.fixtures, discovery: state.discovery, rows: state.rows });
  return { people: state.seats.length, fixtures: state.fixtures };
}

export function beforeNavigation({ paths }) {
  return () => {
    const state = states.get(paths.dir);
    if (state) save(paths, 'conference-sequence.json', {
      qualification: 'concise storytelling diagnostic; full question, handover and independent-agent acceptance remain open',
      result: state.result ?? null, failure: state.failure ?? null, rows: state.rows,
      frameReads: state.frameReads ?? [], frameReadErrors: state.frameReadErrors ?? [],
    });
    states.delete(paths.dir);
  };
}

export default async function ({ page, paths, check, expectHttp, signal }) {
  const state = states.get(paths.dir); assert(state, 'conference-proof preparation missing');
  expectHttp('/safety.md', 404, 'The old-page fixture does not route this optional standalone client document.');
  const url = new URL(page.url()); url.search = 'post=0&hour=12:00&eye=8,5,-8&at=0,1,2';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.viewer-history[data-viewer-ready="true"]') && !document.querySelector('.viewer-arrival'), null, { timeout: 30000 });
  const snapshot = async label => writeFileSync(join(paths.dir, `conference-accessibility-${label}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  await nativeCameraMode(page, 'manual', snapshot);
  await snapshot('escape'); await page.keyboard.press('Escape');
  const bounds = await page.locator('canvas').first().boundingBox();
  check('conference-canvas-drawn', !!bounds && bounds.width > 100 && bounds.height > 100);
  await page.screenshot({ path: join(paths.dir, 'conference-setup.png') });
  signal.throwIfAborted();
  state.frameReads = []; state.frameReadErrors = [];
  let reading = true;
  const readFrames = (async () => {
    while (reading && !signal.aborted) {
      try {
        state.frameReads.push(await page.evaluate(() => {
          const world = window.__soulsEntity;
          if (!world?.gameFrame || !world?.residents) throw Error('conference read-only page diagnostics unavailable');
          const frame = world.gameFrame();
          return { observation: 'read between draws; not a final-draw contact measurement', at: performance.now(),
            renderFrame: world.renderer.info.render.frame, tick: frame.tick, dt: frame.dt, worldSeconds: world.worldSeconds,
            souls: frame.souls, residents: world.residents(), entities: frame.entities, bones: frame.bones };
        }));
      } catch (error) { state.frameReadErrors.push(String(error)); break; }
      await new Promise(ok => setTimeout(ok, 150));
    }
  })();
  try {
    state.result = await explainConference({ speaker: state.seats[0], ...state.fixtures, record: state.record, storyRepeats: 4, interruptStory: true });
    signal.throwIfAborted();
    check('conference-presentation-receipts', state.result.storyActions === 4 && state.result.interrupted === true,
      'Four ordinary story completions, a named interruption and next point/clap completed; not visual acceptance.');
    await page.screenshot({ path: join(paths.dir, 'conference-completion.png') });
  } catch (error) { state.failure = String(error.stack ?? error); throw error; }
  finally { reading = false; await readFrames; }
}
