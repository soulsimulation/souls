// V1's stream as a `Source` (V5, #2714): one address, the stream's directory; the worker does the fetching and the
// playing, so applying a large part never stalls drawing.
import type { Source, SourceEvents } from './source.ts';
import { watchStream } from '../report/beacon.ts';

export class StreamSource implements Source {
  private worker: Worker | null = null;
  private readonly address: string;
  constructor(address: string) {
    this.address = address;
  }

  start(events: SourceEvents): void {
    const on = watchStream(events); // O25: a part failing three times in a row is reported
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'pointer') on.pointer(m.p);
      else if (m.t === 'part') on.part(m.p);
      else on.error(m.message);
    };
    this.worker.onerror = (e) => on.error(e.message);
    this.worker.postMessage({ stream: new URL(this.address, location.href).href });
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
