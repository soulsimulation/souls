import { BASE } from './base-path.ts';
const halo = new URL('./media/starburst.png', import.meta.url).href;
/** Site identity: the starburst, on black, inside the mark's black circle. */
export function EdenMark() {
  return <a className="eden-mark" href={BASE+'/'} aria-label="Souls: all worlds" title="Souls">
    <img src={halo} width="32" height="32" alt="" aria-hidden="true" />
  </a>;
}
