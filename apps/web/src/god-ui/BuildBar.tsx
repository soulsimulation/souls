// 0.133 item 6: Build in the creator's panel on a world the new engine runs. Place: pick one of the world's kinds and
// click the ground. Select: click a thing; drag it, or move it with the arrow keys; Delete (or Remove) removes it. Click
// an area on the open ground (a place) where no thing is, and "New Souls arrive here" names it the world's arrival (#5006).
// Every change is one creator edit on the creator socket (creator-socket.ts, creator-build.ts); nothing moves on the
// page until the world's stream says so, and a refusal (build safety's among them) is shown by its name.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Asked, Op, V2Creator } from '../v2-engine/creator-socket.ts';
import { arrivalSet, buildKinds, buildNodes, isPlace, isThing, moveOp, placeMiddle, placeOp, placeUnder, placedAt, removeOp, setBuildClicks, shortKind, thingNear, thingOf } from '../v2-engine/creator-build.ts';

type Entity = { layer?: { group?: THREE.Object3D; terrainMeshes?(): THREE.Object3D[] }; camera?: THREE.Camera; scene?: THREE.Scene;
  renderer?: { domElement: HTMLCanvasElement }; controls?: { enabled: boolean } };
const world = () => (window as unknown as { __soulsEntity?: Entity }).__soulsEntity ?? null;
/** An arrow key's step, metres. */
const STEP = 1;
/** How near (m) to the selected thing a press starts a drag: a large thing is pressed on its side, not its middle. */
const GRAB = 3;
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable);

export function BuildBar({ creator, start, onClose }: { creator: Promise<V2Creator>; start: 'place' | 'select'; onClose: () => void }) {
  const [mode, setMode] = useState(start);
  const [kinds, setKinds] = useState<string[]>([]);
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef({ mode, kind, selected, busy, onClose });
  live.current = { mode, kind, selected, busy, onClose };

  // the world's kinds, as the stream shows them
  useEffect(() => {
    const read = () => { const n = buildNodes(); if (!n) return; const next = buildKinds(n); setKinds((k) => (k.join() === next.join() ? k : next)); };
    read(); const t = setInterval(read, 1000); return () => clearInterval(t);
  }, []);
  useEffect(() => { if (!kinds.includes(kind) && kinds.length) setKind(kinds[0]!); }, [kinds, kind]);
  // a selected thing that leaves the world (removed, undone) is no longer selected
  // (one just placed is selected before the stream shows it)
  useEffect(() => {
    if (!selected) return;
    let shown = false;
    const t = setInterval(() => { if (buildNodes()?.has(selected)) shown = true; else if (shown) setSelected(null); }, 500);
    return () => clearInterval(t);
  }, [selected]);

  const send = useRef(async (ops: Op[] | Asked, done: string) => {
    setBusy(true); setNote(null);
    try { const r = await (await creator).answer(Array.isArray(ops) ? { ops } : ops, done); setNote({ text: r.said }); return r.names; }
    catch (e) { setNote({ text: (e as Error).message, bad: true }); return null; }
    finally { setBusy(false); }
  }).current;

  useEffect(() => {
    const w = world(), canvas = w?.renderer?.domElement, host = canvas?.parentElement, camera = w?.camera;
    if (!w || !canvas || !host || !camera) { setNote({ text: 'The world view is not ready.', bad: true }); return; }
    setBuildClicks(true);
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), down = new THREE.Vector3(0, -1, 0), flat = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const terrain = () => w.layer?.terrainMeshes?.() ?? [];
    const aim = (x: number, y: number) => { const r = canvas.getBoundingClientRect(); ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); };
    /** The ground under the pointer, the world's frame. */
    const groundAt = (x: number, y: number): THREE.Vector3 | null => {
      aim(x, y);
      const hit = ray.intersectObjects(terrain(), false)[0];
      return hit ? hit.point.clone() : ray.ray.intersectPlane(flat, new THREE.Vector3());
    };
    /** The ground's height at (x, z), or null off it. */
    const heightAt = (x: number, z: number) => { ray.set(new THREE.Vector3(x, 1000, z), down); return ray.intersectObjects(terrain(), false)[0]?.point.y ?? null; };
    /** The thing under the pointer: the entity a hit names, else the thing standing nearest where the ray lands. */
    const pick = (x: number, y: number): string | null => {
      const nodes = buildNodes(); if (!nodes) return null;
      aim(x, y);
      const hits = w.layer?.group ? ray.intersectObject(w.layer.group, true) : [];
      for (const h of hits) for (let o: THREE.Object3D | null = h.object; o; o = o.parent) { const e = o.userData.entity; const id = typeof e === 'string' ? thingOf(nodes, e) : null; if (id) return id; }
      const at = hits[0]?.point ?? groundAt(x, y);
      return at ? thingNear(nodes, [at.x, at.z]) : null;
    };
    /** Whether a press at (x, y) is on thing `id`: the thing hit, or the ground or a surface within GRAB of it. */
    const onThing = (id: string, x: number, y: number) => {
      if (pick(x, y) === id) return true;
      const p = buildNodes() && placedAt(buildNodes()!, id), g = groundAt(x, y);
      return !!p && !!g && Math.hypot(p[0] - g.x, p[2] - g.z) <= GRAB;
    };
    /** Where `id` lands at (x, z): its height over the ground kept, as a move on the open ground does. */
    const landing = (id: string, x: number, z: number): [number, number, number] | null => {
      const p = buildNodes() && placedAt(buildNodes()!, id); if (!p) return null;
      const h0 = heightAt(p[0], p[2]), h1 = heightAt(x, z);
      return [x, h0 !== null && h1 !== null ? p[1] + h1 - h0 : p[1], z];
    };
    const move = (id: string, to: [number, number, number] | null) => {
      const nodes = buildNodes(); if (!nodes || !to) return;
      const op = moveOp(nodes, id, to);
      if ('why' in op) { setNote({ text: op.why, bad: true }); return; }
      void send([op], `Moved the ${shortKind(nodes.get(id)!.kind)} to (${to[0].toFixed(1)}, ${to[2].toFixed(1)}).`);
    };
    // a ring on the selected thing, and where a drag would put it: interface only, never the thing itself
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.85, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffb02e', depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    ring.renderOrder = 998; ring.visible = false; ring.name = 'build-ring'; w.scene?.add(ring);
    let press: { x: number; y: number; drag: boolean } | null = null, dragTo: THREE.Vector3 | null = null;
    const follow = setInterval(() => {
      if (press?.drag) return;
      const id = live.current.selected, nodes = buildNodes(), n = id ? nodes?.get(id) : undefined;
      // a place is ringed at its middle, where new Souls named to it arrive
      const mid = n && nodes && isPlace(nodes, n) ? placeMiddle(n) : null;
      const p = mid ? [mid[0], 0, mid[1]] as const : id && nodes ? placedAt(nodes, id) : null;
      ring.visible = !!p; if (p) ring.position.set(p[0], (heightAt(p[0], p[2]) ?? p[1]) + 0.05, p[2]);
    }, 100);
    /** Whether the selected node is a thing (a place is not dragged, moved or removed here). */
    const thingSelected = () => { const s = live.current.selected, n = s ? buildNodes()?.get(s) : undefined; return !!n && isThing(n); };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.target !== canvas) return;
      press = { x: e.clientX, y: e.clientY, drag: false }; dragTo = null;
      const { mode: m, selected: s, busy: b } = live.current;
      if (m === 'select' && s && !b && thingSelected() && onThing(s, e.clientX, e.clientY)) {
        // a drag of the selected thing: the camera does not orbit while it is held
        press.drag = true; e.stopPropagation(); e.preventDefault(); if (w.controls) w.controls.enabled = false;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!press?.drag) return;
      e.stopPropagation();
      const g = groundAt(e.clientX, e.clientY); if (!g) return;
      dragTo = g; ring.visible = true; ring.position.set(g.x, g.y + 0.05, g.z);
    };
    const onUp = (e: PointerEvent) => {
      const p = press; press = null; if (!p) return;
      if (p.drag) {
        e.stopPropagation(); if (w.controls) w.controls.enabled = true;
        const s = live.current.selected, to = dragTo; dragTo = null;
        if (s && to && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) move(s, landing(s, to.x, to.z));
        return;
      }
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6 || live.current.busy) return; // the camera orbited
      if (live.current.mode === 'place') {
        const nodes = buildNodes(), g = groundAt(e.clientX, e.clientY), k = live.current.kind;
        if (!nodes || !g || !k) return;
        const op = placeOp(nodes, k, [g.x, g.y, g.z]);
        if ('why' in op) { setNote({ text: op.why, bad: true }); return; }
        void send([op], `Placed a ${shortKind(k)} at (${g.x.toFixed(1)}, ${g.z.toFixed(1)}).`).then((names) => { const id = names?.get(1); if (id) setSelected(id); });
        return;
      }
      // a thing, else the place there (the smallest area on the open ground holding the point)
      const nodes = buildNodes(), g = groundAt(e.clientX, e.clientY);
      setSelected(pick(e.clientX, e.clientY) ?? (nodes && g ? placeUnder(nodes, [g.x, g.z]) : null));
    };
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.key === 'Escape') { e.stopPropagation(); if (live.current.selected) setSelected(null); else live.current.onClose(); return; }
      const s = live.current.selected;
      if (!s || live.current.busy || !thingSelected()) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.stopPropagation(); e.preventDefault(); const k = buildNodes()?.get(s)?.kind; void send([removeOp(s)], `Removed the ${k ? shortKind(k) : 'thing'}.`); return; }
      const arrow = ({ ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[e.key];
      if (!arrow) return;
      e.stopPropagation(); e.preventDefault();
      // up is away from the camera, right is the camera's right, on the ground
      const f = camera.getWorldDirection(new THREE.Vector3()).setY(0);
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      f.normalize();
      const p = buildNodes() && placedAt(buildNodes()!, s); if (!p) return;
      const dx = (arrow[1] * f.x - arrow[0] * f.z) * STEP, dz = (arrow[1] * f.z + arrow[0] * f.x) * STEP;
      move(s, landing(s, p[0] + dx, p[2] + dz));
    };
    host.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      setBuildClicks(false); clearInterval(follow);
      host.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      if (w.controls) w.controls.enabled = true;
      ring.removeFromParent(); ring.geometry.dispose(); (ring.material as THREE.Material).dispose();
    };
  }, [send]);

  const nodes = buildNodes(), sel = selected ? nodes?.get(selected) : undefined;
  return <div className="gp-card gp-build" data-build-bar={mode} role="toolbar" aria-label="Build">
    <div className="gp-head">
      <b className="gp-title">Build</b>
      <div className="gm-tool-group" role="group" aria-label="Build mode">
        <button type="button" className={'gp-btn gp-small' + (mode === 'place' ? ' gp-armed' : '')} data-build-mode="place" aria-pressed={mode === 'place'} onClick={() => setMode('place')}>Place</button>
        <button type="button" className={'gp-btn gp-small' + (mode === 'select' ? ' gp-armed' : '')} data-build-mode="select" aria-pressed={mode === 'select'} onClick={() => setMode('select')}>Select</button>
      </div>
      <button className="gp-icon" data-build-close="1" onClick={onClose} title="Close Build (Escape)" aria-label="close build">×</button>
    </div>
    {mode === 'place'
      ? <div className="gp-row">
        <select data-build-kind="1" aria-label="kind to place" value={kind} onChange={(e) => setKind(e.target.value)} disabled={!kinds.length}>
          {kinds.map((k) => <option key={k} value={k}>{shortKind(k)}</option>)}
        </select>
        <span className="gp-dim">{kinds.length ? 'then click the ground' : 'loading the world\'s kinds…'}</span>
      </div>
      : sel && nodes && isPlace(nodes, sel)
        ? <div className="gp-row" data-build-selected={selected!} data-build-place="1">
          <span><b>{sel.placeName || shortKind(sel.kind)}</b> <span className="gp-dim">a place</span></span>
          <button className="gp-btn gp-small" data-build-arrival="1" disabled={busy} onClick={() => {
            const s = selected!, set = arrivalSet(nodes, s);
            if ('why' in set) { setNote({ text: set.why, bad: true }); return; }
            void send(set, `New Souls arrive at ${sel.placeName || 'this place'} from the next one born.`);
          }}>New Souls arrive here</button>
        </div>
      : sel
        ? <div className="gp-row" data-build-selected={selected!}>
          <span><b>{shortKind(sel.kind)}</b> <span className="gp-dim">drag it, or arrow keys</span></span>
          <button className="gp-btn gp-small" data-build-remove="1" disabled={busy} onClick={() => { const s = selected!; void send([removeOp(s)], `Removed the ${shortKind(sel.kind)}.`); }}>Remove</button>
        </div>
        : <p className="gp-dim">Click a thing, or a place, to select it.</p>}
    {busy && <p className="gp-dim">Sending…</p>}
    {note && <p className={note.bad ? 'gp-bad' : 'gp-ok'} data-build-note={note.bad ? 'refused' : 'done'} role="status">{note.text}</p>}
  </div>;
}
