// #2300 baseline: `node --import <this> apps/server/src/main.ts` arms the fault poller in a one-world program.
import { armFaults } from './faults.mjs';
armFaults(process.env.DATA_DIR);
