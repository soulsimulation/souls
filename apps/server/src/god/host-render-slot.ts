// Architectural captures, God.look and sheet jobs share one slot across world processes.
// Existing Soul Eyes workers retain their own lifecycle and resource use.
// No polling survives a waiting job.
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireLock } from '../../../../tools/god-skill/lib/locks.mjs';
const exec = promisify(execFile);
export function hostRenderLockPath(env = process.env, platform = process.platform) {
    const directory = env.SIM_RENDER_LOCK_DIR;
    if (directory) {
        if (!isAbsolute(directory))
            throw new Error('SIM_RENDER_LOCK_DIR must be an absolute host-shared writable directory');
        return join(directory, 'render.lock');
    }
    if (platform === 'linux')
        throw new Error('Configure SIM_RENDER_LOCK_DIR outside systemd PrivateTmp for all world units');
    return join(tmpdir(), 'sim-host-render-slot');
}
/** #2444 shards: the world a call runs for, in a program of several worlds. The shard program (tools/world-launcher/shard.mjs)
 *  starts each world inside it, so the world's timers, requests and promises carry it; unset in a program of one world. */
export const renderWorld = new AsyncLocalStorage<string>();
/** The slot's liveness is checked by pid, and a shard's pid outlives a world it stops. #2469: a slot is freed only by its
 *  own render's end (every caller releases in `finally`), never by its world's stop while the render is mid-way (#2444
 *  freed it then, and a second render could start beside the first). A stopped world's renders end with its stop: its
 *  context views abort them (context-views.ts `close`), so its slot does not outlive them. */
export async function hostRenderSlot(signal: AbortSignal) {
    const path = hostRenderLockPath();
    let nextIdentityCheck = 0;
    for (;;) {
        signal.throwIfAborted();
        let tryAcquire = false;
        try {
            const record = JSON.parse(await readFile(join(path, 'holder'), 'utf8')), holder = record.holder;
            if (!holder?.pid)
                throw new Error('incomplete holder');
            try {
                process.kill(holder.pid, 0);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ESRCH')
                    tryAcquire = true;
            }
            // Existing acquireLock performs synchronous ps probes. Keep ordinary contention entirely
            // asynchronous; only a missing/dead/recycled owner enters its atomic recovery protocol.
            if (!tryAcquire && Date.now() >= nextIdentityCheck && holder.pid !== process.pid) {
                nextIdentityCheck = Date.now() + 5000;
                const result = await exec('ps', ['-p', String(holder.pid), '-o', 'lstart='], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, timeout: 1000, signal }).catch(() => null);
                if (result?.stdout.trim() && holder.start.startsWith('ps:') && holder.start !== `ps:${result.stdout.trim()}`)
                    tryAcquire = true;
            }
        }
        catch {
            const info = await stat(path).catch(() => null);
            tryAcquire = !info || Date.now() - info.mtimeMs > 30000;
        }
        signal.throwIfAborted();
        if (tryAcquire) {
            try {
                return acquireLock(path, { label: 'Sim architectural/owner renderer', reentrant: false });
            }
            catch (e) {
                if ((e as {
                    code?: string;
                }).code !== 'lock.busy')
                    throw e;
            }
        }
        await setTimeout(200, undefined, { signal });
    }
}
