import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const budgets = read('budgets.json'), scenarios = read('scenarios.json');
const profiles = new Set(Object.keys(scenarios.profiles));

test('all paired seeds remain unique across tuning, holdout and reserve, including second repeats', () => {
  assert.equal(budgets.protocol, scenarios.protocol);
  const effective = scenarios.cases.flatMap(c => [c.seed, c.seed + 10000]);
  assert.equal(new Set(effective).size, effective.length);
  assert.equal(new Set(scenarios.cases.map(c => c.id)).size, scenarios.cases.length);
  for (const set of Object.keys(scenarios.sets)) {
    assert.deepEqual(new Set(scenarios.cases.filter(c => c.set === set).map(c => c.profile)), profiles);
  }
});

test('predeclared intervals cover each fixture once without gaps, overlap or post-run exclusion', () => {
  for (const [id, c] of Object.entries(scenarios.profiles)) {
    const intervals = [...c.feasibility.feasibleSeconds, ...c.feasibility.infeasibleSeconds].sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [from, to] of intervals) {
      assert.equal(from, end, id);
      assert.ok(to > from && to <= c.durationSeconds, id);
      end = to;
    }
    assert.equal(end, c.durationSeconds, id);
    assert.deepEqual(c.feasibility.infeasibleSeconds, [], 'initial fixtures promise a feasible shot throughout');
  }
});

test('run cells reference declared resources, arms, scenarios and two repeats; scheduled totals are real time', () => {
  for (const matrix of scenarios.matrices) {
    assert.equal(matrix.repeats, scenarios.repeatsPerArm, matrix.id);
    for (const role of matrix.resources) assert.ok(budgets.references[role], role);
    for (const arm of matrix.arms) assert.ok(scenarios.arms[arm], arm);
    for (const set of matrix.sets) assert.ok(scenarios.sets[set], set);
    for (const profile of matrix.profiles) assert.ok(profiles.has(profile) || ['mixed', 'mobile-mixed'].includes(profile), profile);
    const cells = ['sets', 'resources', 'arms', 'profiles', 'conditions', 'orientations'].reduce((n, key) => n * matrix[key].length, matrix.repeats);
    if (matrix.totalRecordingMinutes) assert.equal(cells * matrix.secondsPerCell / 60, matrix.totalRecordingMinutes, matrix.id);
  }
});

test('mixed schedules are continuous and mode coverage is reported rather than multiplied', () => {
  for (const session of [scenarios.mixedSession, scenarios.mobileSession]) {
    let end = 0;
    for (const segment of session.segments) {
      assert.equal(segment.seconds[0], end);
      assert.ok(segment.seconds[1] > end);
      assert.ok(profiles.has(segment.profile));
      assert.ok(scenarios.profiles[segment.profile].mode === segment.mode);
      end = segment.seconds[1];
    }
    assert.equal(end, session.periodSeconds);
  }
  const follow = scenarios.mobileSession.segments.filter(s => s.mode === 'follow').reduce((n, s) => n + s.seconds[1] - s.seconds[0], 0);
  assert.equal(follow, 14 * 60);
  assert.equal(scenarios.mobileSession.periodSeconds - follow, 6 * 60);
});

test('cut limits are positive and missing physical evidence cannot qualify by emulation', () => {
  for (const cuts of [budgets.visual.followDiscretionaryCuts, budgets.visual.broadcastDiscretionaryCuts]) {
    assert.ok(cuts.minimumSpacingSeconds > 0);
    assert.ok(cuts.maximumPerRollingMinute > 0);
  }
  assert.equal(budgets.references.mobile.emulationQualifies, false);
  assert.equal(scenarios.render.portraitEmulation.physicalEvidence, false);
  assert.equal(scenarios.render.landscapeEmulation.physicalEvidence, false);
});
