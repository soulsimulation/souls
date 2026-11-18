// X6 (#2819) test hook, preloaded with `--import`: every `node:sqlite` import resolves here, and each database the
// process opens is written to stderr as one `sqlite-open {path, options}` line before it opens.
import { registerHooks } from 'node:module';
import * as real from 'node:sqlite';

const self = import.meta.url;
registerHooks({ resolve: (spec, ctx, next) => (spec === 'node:sqlite' && ctx.parentURL !== self ? { url: self, shortCircuit: true } : next(spec, ctx)) });

export class DatabaseSync extends real.DatabaseSync {
  constructor(path, options) {
    process.stderr.write(`sqlite-open ${JSON.stringify({ path: String(path), options: options ?? null })}\n`);
    super(path, options);
  }
}
export const { backup, StatementSync, constants } = real;
