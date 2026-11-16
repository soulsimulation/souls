// #2466: a Soul's body in the homepage's My Souls modal, idling: its humanoid look composed by the same kit and rig as the
// world view and the look picker (humanoid/compose.ts, people.ts createRig), playing the rig's Idle clip (its breathing),
// with a slow look-around of the head and shoulders. Its own small renderer; loaded only when a modal opens.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createRig } from '../../../../mars/viewer/app/engine-view/people.ts';
import { humanoidKit } from '../humanoid/compose.ts';

export default function HomeSoulBody({ look, name, onFail }: { look: Record<string, unknown>; name: string; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const el = host.current; if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { onFail(); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff4e0, 0x6b5a45, 1.6)); const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(3, 6, 5); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
    const fit = () => { const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    renderer.domElement.setAttribute('aria-label', `${name}'s body`); renderer.domElement.setAttribute('role', 'img');
    el.appendChild(renderer.domElement); fit();
    const resize = new ResizeObserver(fit); resize.observe(el);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0, live = true, rig: ReturnType<typeof createRig> | null = null, head: THREE.Object3D | null = null, chest: THREE.Object3D | null = null;
    let last = performance.now(), time = 0;
    const frame = () => {
      const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt;
      if (rig) {
        rig.mixer.update(dt);
        // the look-around: a slow glance left and right with a small nod, layered over the Idle clip's pose
        const glance = still ? 0 : Math.sin(time * 0.45) * 0.55 + Math.sin(time * 0.17) * 0.2;
        if (head) { head.rotateY(glance * 0.7); head.rotateX(still ? 0 : Math.sin(time * 0.31) * 0.06); }
        if (chest) chest.rotateY(glance * 0.15);
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    humanoidKit(new GLTFLoader()).template(look).then((t) => {
      if (!live) return;
      rig = createRig(t); rig.holder.rotation.y = -Math.PI / 2 + 0.25; scene.add(rig.holder);
      rig.holder.traverse((o) => { if ((o as THREE.Bone).isBone) { if (!head && /head$/i.test(o.name)) head = o; if (!chest && /(chest|spine2|upperchest)$/i.test(o.name)) chest = o; } });
      // frame the whole body: its height from the composed template (1.75 m at scale 1)
      const tall = 1.75 * (t.bodyScale ?? 1), dist = (tall * 1.08) / (2 * Math.tan((camera.fov * Math.PI) / 360));
      camera.position.set(0, tall * 0.56, dist); camera.lookAt(0, tall * 0.52, 0);
      setReady(true);
    }).catch(() => { if (live) onFail(); });
    raf = requestAnimationFrame(frame);
    return () => { live = false; cancelAnimationFrame(raf); resize.disconnect(); renderer.dispose(); renderer.domElement.remove(); };
  }, [look]);
  return <div ref={host} className="hs-canvas" data-soul-body={ready ? 'ready' : 'loading'} />;
}
