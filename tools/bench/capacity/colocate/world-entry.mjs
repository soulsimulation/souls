// #2300 form 1: one world on its own worker thread. The worker's env (DATA_DIR, PORT, …) is its own copy (Worker
// `env`), so the server's module graph loads fresh in this isolate exactly as in a program of its own.
import { workerData } from 'node:worker_threads';
import { armFaults } from './faults.mjs';
armFaults(process.env.DATA_DIR);
await import(workerData.main);
