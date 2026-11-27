#!/usr/bin/env node
// A conference is a composition of the existing lecture, questions, introductions and applause.
// This rehearsal sends the same served-client commands an agent uses; it never changes a body or pose directly.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { startOldPage } from '../arena/new-engine/old-page.mjs';
import { exportFacts } from '../arena/new-engine/world.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = ['Presenter', 'Cedar', 'Maple', 'Willow', 'Birch'];

/** Use the shipped furniture, with room to walk round it; no new kind or world map is authored. */
export function rehearsalTemplate(eden) {
  const wanted = ['core-hall_lecture', 'core-conference_question'];
  const definitions = eden.batches.flatMap((batch) => batch.ops).filter((op) =>
    op.op === 'define' && wanted.includes(op.def.name));
  assert.deepEqual(definitions.map((op) => op.def.name).sort(), [...wanted].sort(), 'existing furniture definitions');
  return {
    schema: 'genesis/1', name: 'Presentation rehearsal', description: 'A lectern and four audience seats.',
    constants: { extent: 50, ground: 'land' },
    batches: [{ group: 'conference-rehearsal', ops: [...definitions,
      { op: 'place', def: 'core/hall_lecture@1', name: 'presentation-lectern', p: [0, 0, 4] },
      { op: 'place', def: 'core/conference_question@1', name: 'question-stand', p: [3, 0, 3] },
      { op: 'place', def: 'core/bench@1', name: 'audience-left', p: [-1.4, 0, 0], r: 0 },
      { op: 'place', def: 'core/bench@1', name: 'audience-right', p: [1.4, 0, 0], r: 0 },
    ] }],
  };
}

export function completed(answer, label) {
  assert.equal(answer.ok, true, `${label}: ${answer.code ?? 'not accepted'}`);
  assert.equal(answer.phase, 'done', `${label}: ${answer.phase ?? 'no terminal receipt'}`);
  assert(answer.receipt?.answers?.some((row) => row.answer === 'receipt'), `${label}: terminal receipt`);
  return answer;
}

/** Check what an ordinary agent can learn before running the fixed-sequence diagnostic below. */
export async function discoverConference({ seat, lecture, question, record = () => {} }) {
  const read = async (...words) => {
    const answer = await seat.cli(...words);
    record({ person: seat.label, words, answer });
    assert.equal(answer.ok, true, `discovery ${words.join(' ')}`);
    return answer;
  };
  await read('help');
  await read('look');
  const activities = (await read('together', 'kinds')).activities;
  for (const word of ['hall-lecture', 'speaker-introduction', 'round-of-applause']) {
    assert(activities?.some((a) => a.word === word && a.card), `${word} has an ordinary activity card`);
  }
  const lectern = await read('inspect', lecture), stand = await read('inspect', question);
  assert(stand.card?.includes('withdraw'), 'the question card explains how the author frees the stand');
  const form = (thing, name) => {
    const offer = thing.offers?.find((o) => o.name === name);
    assert(offer?.usage, `${name} exposes its ordinary command usage`);
    return offer;
  };
  assert(form(lectern, 'take_the_lectern').params?.place?.of?.includes('lectern'), 'the lectern names its standing place');
  assert.equal(form(lectern, 'attend').params?.seat?.type, 'slot', 'attending names the required seat argument');
  for (const name of ['step_down', 'leave']) form(lectern, name);
  assert.equal(form(stand, 'post_question').params?.words?.type, 'text', 'posting names the words argument');
  for (const name of ['mark_answered', 'withdraw_question']) {
    assert.deepEqual(form(stand, name).who, { link: 'asker' }, `${name} names its author-only permission`);
  }
  return { activities: 3, lectern: lectern.offers, question: stand.offers };
}

function conferenceCommands(record) {
  const command = async (seat, ...words) => {
    const answer = await seat.cli(...words);
    record({ person: seat.label, words, answer });
    return answer;
  };
  const act = async (seat, form, target, ...args) => completed(await command(seat, 'act', `${form}:${target}`, ...args, '--wait'), form);
  const body = async (seat, form, ...args) => completed(await command(seat, 'act', form, ...args, '--wait'), form);
  const parent = async (seat) => (await command(seat, 'inspect', seat.body)).parent;
  const offer = async (leader, activity, others) => {
    completed(await command(leader, 'together', 'offer', activity, ...others.map((seat) => seat.body)), `offer ${activity}`);
    for (const other of others) completed(await command(other, 'together', 'accept', activity), `accept ${activity}`);
  };
  const leave = async (seat, activity) => completed(await command(seat, 'together', 'leave', activity), `leave ${activity}`);
  return { command, act, body, parent, offer, leave };
}

export async function assembleConference({ seats, lecture, benches, record = () => {}, observe = async () => {} }) {
  assert.equal(seats.length, 5, 'one speaker and four listeners');
  const [speaker, ...listeners] = seats, { act, offer } = conferenceCommands(record);
  // Forms take their places first. Offering first binds the same links, so taking a place then can refuse link-full.
  await observe('assembly-start', { seat: speaker, listeners });
  await act(speaker, 'take_the_lectern', lecture, 'place=lectern');
  await observe('lectern-ready', { seat: speaker });
  for (let index = 0; index < listeners.length; index++) {
    const seat = listeners[index], bench = benches[Math.floor(index / 2)];
    // Mark before the command starts: a terminal receipt alone cannot witness sit entry.
    await observe('attend-start', { seat, bench });
    await act(seat, 'attend', lecture, `seat=${bench}/${index % 2 ? 'right' : 'left'}`);
    await observe('attend-done', { seat, bench });
  }
  await offer(speaker, 'hall-lecture', listeners);
  await observe('lecture-ready', { seat: speaker, listeners });
}

export async function explainConference({ speaker, lecture, question, record = () => {}, storyRepeats = 1, interruptStory = false, observe = async () => {} }) {
  assert(Number.isSafeInteger(storyRepeats) && storyRepeats >= 1 && storyRepeats <= 4, 'one to four ordinary story actions per presentation');
  const { command, body, parent } = conferenceCommands(record);
  assert.equal(await parent(speaker), lecture, 'speaker is at the lectern');
  // Each native action remains four seconds; repeated ordinary actions expose the global-clock phrase cycle.
  for (let repeat = 0; repeat < storyRepeats; repeat++) {
    await observe('story-start', { seat: speaker, repeat });
    await body(speaker, 'tell_story');
    await observe('story-complete', { seat: speaker, repeat });
  }
  assert.equal(await parent(speaker), lecture, 'story gesture preserves the lectern');
  let interrupted;
  if (interruptStory) {
    interrupted = await command(speaker, 'act', 'tell_story');
    assert(interrupted.ok === true && interrupted.sequence !== undefined, 'ordinary story was sent');
    for (const until = Date.now() + 2000;;) {
      const receipt = await command(speaker, 'receipt', String(interrupted.sequence));
      const end = receipt.receipt?.answers?.at(-1);
      assert(receipt.ok && (!end || end.answer === 'accepted'), 'story must still be running before interruption');
      // I10: progress is emitted in the form run-start tick; sending an intent alone proves no start.
      if (end?.answer === 'accepted' && receipt.receipt.going === true) break;
      assert(Date.now() < until, 'story run-start progress missing');
      await sleep(50);
    }
    await observe('tell-story', { seat: speaker, sequence: interrupted.sequence });
    await sleep(250); // Real-speed demonstration interval after the observed native start.
  }
  await body(speaker, 'point', `toward=${question}`);
  assert.equal(await parent(speaker), lecture, 'aimed point preserves the lectern');
  if (interrupted) {
    const receipt = await command(speaker, 'receipt', String(interrupted.sequence));
    const end = receipt.receipt?.answers?.at(-1);
    assert(end?.answer === 'refused' && end.reason === 'left', 'story replacement must end with native refused:left');
    await observe('point', { seat: speaker });
    await body(speaker, 'clap', 'for=1');
    assert.equal(await parent(speaker), lecture, 'next gesture preserves the lectern');
    await observe('settled', { seat: speaker });
  }
  return { interrupted: Boolean(interrupted), storyActions: storyRepeats };
}

export async function performConference({ seats, lecture, benches, question, record = () => {}, storyRepeats = 1, interruptStory = false, observe = async () => {} }) {
  assert.equal(seats.length, 5, 'one speaker and four listeners');
  const [presenter, next] = seats;
  let interruptedStories = 0;
  const { command, act, body, parent, offer, leave } = conferenceCommands(record);
  const assemble = (speaker, listeners) => assembleConference({ seats: [speaker, ...listeners], lecture, benches, record, observe });
  const explain = async speaker => { const result = await explainConference({ speaker, lecture, question, record, storyRepeats, interruptStory, observe }); interruptedStories += Number(result.interrupted); };
  async function closeLecture(speaker, listeners) {
    // Successful permission-checked step_down also proves the speaker link survived the gestures.
    await observe('departure-start', { seat: speaker, listeners });
    // Leaving an activity may itself release a seat. Observe before that command as well as any explicit rise.
    const seated = [];
    for (const listener of listeners) if (benches.includes(await parent(listener))) {
      seated.push(listener); await observe('rise-start', { seat: listener });
    }
    await act(speaker, 'step_down', lecture);
    for (const listener of listeners) await leave(listener, 'hall-lecture');
    await leave(speaker, 'hall-lecture');
    for (const listener of seated) {
      if (benches.includes(await parent(listener))) await body(listener, 'rise');
      await observe('rise-done', { seat: listener });
    }
  }
  await assemble(presenter, seats.slice(1));
  await explain(presenter);
  const audienceBench = await parent(next);
  assert(benches.includes(audienceBench), 'questioner begins in an audience seat');
  await observe('seated-wave-start', { seat: next });
  await body(next, 'wave', 'for=1');
  assert.equal(await parent(next), audienceBench, 'audience gesture preserves its seat');
  await observe('seated-wave-done', { seat: next });
  await observe('rise-start', { seat: next });
  await body(next, 'rise');
  await observe('rise-done', { seat: next });
  await observe('question-start', { seat: next });
  await act(next, 'post_question', question, 'words=How do the parts fit together?');
  await observe('question-posted', { seat: next });
  const occupied = await command(next, 'can', `post_question:${question}`, 'words=Another question');
  assert.equal(occupied.can, 'no', 'an author cannot replace a pending question silently');
  assert.equal(occupied.reason, 'already_linked', 'the refusal names the occupied question link');
  assert.equal(occupied.says, 'question_pending', 'the refusal identifies the authored pending-question guidance');
  await observe('question-refused', { seat: next, answer: occupied });
  await body(presenter, 'tell_story');
  await act(next, 'mark_answered', question);
  await act(next, 'withdraw_question', question);
  assert.equal((await command(next, 'can', `post_question:${question}`, 'words=Another question')).can, 'yes',
    'withdrawing makes the question stand usable again');
  await observe('question-recovered', { seat: next });
  await closeLecture(presenter, seats.slice(1));
  await observe('introduction-start', { seat: presenter, guest: next });
  await offer(presenter, 'speaker-introduction', [next]);
  // Observe its actual end, including the walk to its places, before attempting the next activity.
  for (const until = Date.now() + 30000;;) {
    const look = await command(next, 'look');
    if (!(look.doing ?? []).some((line) => line.includes('speaker-introduction'))) break;
    assert(Date.now() < until, 'the introduction must finish before the next presentation');
    await sleep(200);
  }
  await observe('introduction-done', { seat: presenter, guest: next });
  const listeners = [presenter, ...seats.slice(2)];
  await assemble(next, listeners);
  await explain(next);
  await closeLecture(next, listeners);
  await observe('applause-start', { seat: next, listeners });
  await offer(next, 'round-of-applause', listeners);
  await sleep(3500);
  // Every participant leaves; no background activity is kept running after the demonstration.
  for (const seat of [...listeners, next]) await leave(seat, 'round-of-applause');
  for (const seat of seats) {
    const look = await command(seat, 'look');
    assert.equal(look.ok, true, 'conference cleanup read succeeds');
    assert(!(look.doing ?? []).some(line => /hall-lecture|speaker-introduction|round-of-applause/.test(line)),
      'conference activities must end after all participants leave');
  }
  await observe('conference-clean', { seats });
  return { people: seats.length, presentations: 2, question: 'posted-answered-withdrawn', handover: true, interruptedStories };
}

/** Fresh homes run the exact client downloaded from the served world, including its normal pairing flow. */
async function pairServedSeat({ world, page, directory, folder, index, record }) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, SOULS_HOME: join(folder, '.souls'), BRAIN_MODE: 'fake' };
  mkdirSync(folder, { recursive: true });
  const seat = { label: names[index], body: null, cli: async (...words) => {
    const result = await exec(process.execPath, [join(directory, 'served-client.mjs'), ...words], {
      cwd: folder, env, timeout: 90000, maxBuffer: 8000000,
    });
    const lines = result.stdout.trim().split('\n');
    for (const line of lines.reverse()) { try { return JSON.parse(line); } catch { /* pair also prints its approval link */ } }
    throw new Error('the served client returned no JSON answer');
  } };
  const pairing = await seat.cli('pair', page, '--name', names[index]);
  assert.equal(pairing.step, 'approve', 'ordinary owner approval requested');
  const response = await fetch(new URL('/v1/pair/approve', world.directory), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, confirm: true, test_person: `conference-owner-${index}` }),
  });
  assert.equal(response.status, 200, 'test owner approves the requested Soul');
  for (let until = Date.now() + 30000; Date.now() < until;) {
    const status = await seat.cli('status');
    if (status.connected && !status.syncing && status.body) { seat.body = status.body; record({ person: seat.label, status }); return seat; }
    await sleep(100);
  }
  throw new Error('the paired Soul did not arrive');
}

export async function rehearse({ directory, startFile = null, onReady = () => {} }) {
  directory = resolve(directory);
  assert(!existsSync(directory), 'use a fresh isolated output directory');
  assert(directory.startsWith(join(REPO_ROOT, '.local') + '/'), 'rehearsal outputs belong in this checkout’s ignored .local/');
  mkdirSync(directory, { recursive: true });
  const report = { fakeMinds: true, rows: [], complete: false };
  const save = () => {
    const file = join(directory, 'rehearsal-private.json');
    writeFileSync(file + '.tmp', JSON.stringify(report, null, 2));
    renameSync(file + '.tmp', file);
  };
  const record = (row) => { report.rows.push({ at: Date.now(), ...row }); save(); };
  const template = join(directory, 'presentation-rehearsal.json');
  writeFileSync(template, JSON.stringify(rehearsalTemplate(JSON.parse(readFileSync(join(REPO_ROOT, 'worlds/templates/eden-2026.json'), 'utf8')))));
  const facts = exportFacts(template, join(directory, 'facts.json'), join(REPO_ROOT, 'content/worlds/eden/map.json'));
  let running;
  const seats = [];
  try {
    running = await startOldPage({ template, facts, dir: join(directory, 'page') });
    report.page = running.page; save();
    const configResponse = await fetch(running.page + 'v1/config');
    const config = await configResponse.json();
    const clientResponse = await fetch(running.page + 'eden.mjs');
    const client = Buffer.from(await clientResponse.arrayBuffer());
    assert.equal(clientResponse.status, 200); assert.equal(hash(client), config.soulClient.sha256, 'served client hash');
    writeFileSync(join(directory, 'served-client.mjs'), client);
    report.clientSHA256 = hash(client);
    for (let index = 0; index < 5; index++) seats.push(await pairServedSeat({ world: running.world, page: running.page, directory, folder: join(directory, 'people', String(index)), index, record }));
    const find = async (words, kind) => (await seats[0].cli('find', words)).found.filter((node) => node.kind === kind);
    const lecture = (await find('presentation-lectern', 'eden:hall_lecture'))[0]?.id;
    const question = (await find('question-stand', 'eden:conference_question'))[0]?.id;
    const benches = (await find('audience', 'eden:bench')).sort((a, b) => a.name.localeCompare(b.name)).map((node) => node.id);
    assert(lecture && question && benches.length === 2, 'existing conference fixtures are visible to the served client');
    report.discovery = await discoverConference({ seat: seats[0], lecture, question, record });
    report.ready = true; save(); await onReady({ page: running.page, directory });
    if (startFile) { while (!existsSync(startFile)) await sleep(100); }
    report.demonstrationStart = Date.now(); save();
    report.result = await performConference({ seats, lecture, question, benches, record });
    report.complete = true; report.demonstrationEnd = Date.now(); save();
    await sleep(1500);
    return report;
  } catch (error) { report.failure = String(error.stack ?? error); save(); throw error; }
  finally {
    await Promise.allSettled(seats.map((seat) => seat.cli('quit')));
    if (running) await running.stop();
    report.stopped = true; save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag) + 1];
  if (!args.includes('--dir')) throw new Error('usage: rehearse.mjs --dir .local/<fresh folder> [--start-file <recorder marker>]');
  const result = await rehearse({ directory: value('--dir'), startFile: args.includes('--start-file') ? resolve(value('--start-file')) : null,
    onReady: ({ page }) => console.log(JSON.stringify({ ready: true, page })),
  });
  console.log(JSON.stringify({ complete: result.complete, result: result.result }));
}
