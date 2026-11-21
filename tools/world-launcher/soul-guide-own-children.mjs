// Test-only preload (soul-guide.test.mjs): a CLI under test may start a detached, unref'd child (the feed check's
// `news --fetch`) that keeps writing the synthetic home after the CLI exits. Loaded with --import, this makes every spawn
// in the CLI and its descendants attached and on the fixture's pipes, so the fixture's 'close' means the whole tree is done.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const spawn = childProcess.spawn;
childProcess.spawn = function ownedSpawn(file, args, opts) {
  if (!Array.isArray(args)) { opts = args; args = []; }
  return spawn.call(this, file, args, { ...opts, detached: false, stdio: 'inherit' });
};
syncBuiltinESMExports();   // the named `spawn` import of an ES module reads the patched one too
