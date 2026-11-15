// The world server: one world per program, read from this process's environment once (#2389: a world is a function,
// world-main.ts startWorld; the program only chooses its config).
import { loadConfig } from './config.ts';
import { startWorld } from './world-main.ts';

await startWorld(loadConfig(process.env));
