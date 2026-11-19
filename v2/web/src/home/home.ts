// The front door's page (Engine v2 O19, #2830): one list of the worlds on both systems (list.ts), a sign-in link to the
// primary origin's bridge that returns here, and the carried-over visitor count.
import { countPage } from '../visitor-counts.ts';
import { rows, type DirectoryList, type TodayList } from './list.ts';

const read = <T>(path: string): Promise<T | null> =>
  fetch(path, { headers: { accept: 'application/json' } }).then((r) => (r.ok ? (r.json() as Promise<T>) : null), () => null);

async function page(): Promise<void> {
  countPage();
  const list = document.getElementById('list') as HTMLUListElement;
  const [directory, today] = await Promise.all([read<DirectoryList>('/v1/worlds'), read<TodayList>('/__sim/worlds.json')]);
  const all = rows(directory, today);
  list.replaceChildren(...(all.length ? all.map((w) => {
    const li = document.createElement('li'), a = document.createElement('a'), s = document.createElement('span');
    a.textContent = w.name;
    a.href = w.href;
    li.dataset.system = w.system;
    s.className = 'muted';
    s.textContent = [w.note, w.system === 'v2' ? 'new engine' : ''].filter(Boolean).join(' · ');
    li.append(a, ' ', s);
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'muted', textContent: directory || today ? 'no worlds yet' : 'the list could not be read' })]));
  const sign = document.getElementById('sign-in') as HTMLAnchorElement;
  sign.href = '/src/account/';
  sign.hidden = false;
}

void page();
