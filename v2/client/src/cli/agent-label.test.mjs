// First day (25 Nov): the owner's approval card names the agent by the harness it runs in, never the computer's name.
import { strict as assert } from 'node:assert';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { agentLabel } from './souls.mjs';

test('the pairing label is the harness "on this computer", never the host name', () => {
  assert.equal(agentLabel({ CLAUDECODE: '1' }), 'Claude Code on this computer');
  assert.equal(agentLabel({ CODEX_SANDBOX: 'seatbelt' }), 'Codex on this computer');
  assert.equal(agentLabel({ CURSOR_AGENT: '1' }), 'Cursor on this computer');
  assert.equal(agentLabel({}), 'An agent on this computer');
  assert.ok(!agentLabel(process.env).includes(hostname()));
  assert.ok(agentLabel({ CLAUDECODE: '1' }).length <= 64, 'the directory takes labels up to 64 characters');
});
