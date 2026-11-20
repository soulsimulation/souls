// Placement/cutover writers share this per-file lock and atomic read-modify-publish operation.
// The origin only reads the resulting file; no public route calls this writer.
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readWorldRoutes } from '../../origin/world-routes.mjs';

/** Patch one world without losing other worlds or a concurrent writer's fields. A stale lock refuses, never steals. */
export async function updateWorldRoute(file, world, patch) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(world) || !patch || Object.keys(patch).some(k => !['gateway', 'stream', 'history', 'canonical'].includes(k))) throw Error('world-route-update-invalid');
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`, until = Date.now() + 5000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= until) throw Error('world-route-update-busy');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const temporary = `${lock}/next.json`;
  try {
    let value;
    try { value = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      value = { schema: 'souls/world-routes/1', worlds: {} };
    }
    if (value.schema !== 'souls/world-routes/1' || !value.worlds || Array.isArray(value.worlds)) throw Error('world-routing-unconfigured');
    value.worlds[world] = { ...value.worlds[world], ...patch };
    const handle = await open(temporary, 'wx', 0o644);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    readWorldRoutes(temporary);
    await rename(temporary, file);
    const parent = await open(dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(lock, { recursive: true, force: true }); }
}
