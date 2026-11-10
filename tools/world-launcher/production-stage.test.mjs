// #1649: the deploy stage reaches every world as SIM_STAGE (the explicit production marker that refuses dev-only options).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decorateCommand } from './production.mjs';

test('the stage reaches the world; a world env cannot claim one the launcher did not set', () => {
  const s = { devAuth: false, publicOrigin: 'https://sim.eden.art', base: '/worlds', worldHeapMb: 0 };
  assert.equal(decorateCommand({ cmd: 'node', args: [], env: { WORLD_KEY: 'a' } }, { ...s, stage: 'production' }).env.SIM_STAGE, 'production');
  assert.equal(decorateCommand({ cmd: 'node', args: [], env: { WORLD_KEY: 'a' } }, { ...s, stage: 'staging' }).env.SIM_STAGE, 'staging');
  // a world env cannot claim a stage: with dev auth and no stage it carries none
  assert.equal('SIM_STAGE' in decorateCommand({ cmd: 'node', args: [], env: { WORLD_KEY: 'a', SIM_STAGE: 'production' } }, { ...s, devAuth: true, publicOrigin: 'http://127.0.0.1:4980', stage: null }).env, false);
});

test('fail closed: no known stage and no dev auth is production; a world env cannot downgrade it', () => {
  const s = { devAuth: false, publicOrigin: 'https://sim.eden.art', base: '/worlds', worldHeapMb: 0, stage: null };
  assert.equal(decorateCommand({ cmd: 'node', args: [], env: { WORLD_KEY: 'a' } }, s).env.SIM_STAGE, 'production');
  assert.equal(decorateCommand({ cmd: 'node', args: [], env: { WORLD_KEY: 'a', SIM_STAGE: 'staging' } }, s).env.SIM_STAGE, 'production');
});
