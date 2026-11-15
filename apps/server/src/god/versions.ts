import { SKILL_VERSION } from '../../../../tools/god-skill/lib/version.mjs';

import { program } from '../config.ts';

// The launcher already supplies BUILD_ID; prefer an explicitly pinned source commit.
export const sourceVersion = (commit?: string, build = program.build) => commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : build;
export const godVersions = Object.freeze({
  protocol: 'god/1', schema: 'god-schema/1', skill: SKILL_VERSION,
  source: sourceVersion(program.sourceCommit),
});
