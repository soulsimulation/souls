// #1774: the client's full session record (#1773, client 2.29.0) is switched on by an empty `.eden-record-on`.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RECORD_ON = '.eden-record-on';
/** Switch the record on for a seat folder before its first command. A Souls home reads it from `.souls/`; a plain Soul
 *  folder (the seeded seat, until it imports) from the folder itself. Nothing the agent's commands print changes. */
export function recordOn(folder) {
  const home = join(folder, '.souls');
  const f = existsSync(join(home, 'config.json')) ? join(home, RECORD_ON) : join(folder, RECORD_ON);
  if (!existsSync(f)) writeFileSync(f, '');
  return f;
}
