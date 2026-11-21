// Far scattered things drawn as flat stand-ins (#3786), today's WorldFarStandIns (apps/web/src/WorldFarStandIns.ts,
// copied, not imported), on the phone tier as today. A part of a model many things share (trees, plants, benches, small
// things), small enough and of enough triangles, is drawn past `cardRadiusPx` CSS pixels of radius as one camera-facing
// card (two triangles, no shadow): a snapshot of that part taken once from the side (albedo only, transparent
// background), tinted with the instance's own colour, standing on the part's footprint. The thing layer moves a part
// between its model batch and the cards like its other bands (things.ts), so far woods keep their silhouette. Unlike
// today, every part's picture is a cell of one atlas, so all the cards are one draw (one a part cost a phone about 40
// more draws on Eden, measured).
import * as THREE from 'three';

export type StandInOptions = { cardRadiusPx: number; minInstances: number; minTriangles: number; maxRadius: number; snapshotsPerFrame: number };
/** Today's PHONE_STAND_INS. */
export const PHONE_STAND_INS: StandInOptions = Object.freeze({ cardRadiusPx: 7, minInstances: 12, minTriangles: 40, maxRadius: 6, snapshotsPerFrame: 2 });

const triangles = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position')?.count ?? 0) / 3;

/** Whether a part of a model `instances` things share may become a card (today's `eligible`, and its size limit): decals
 *  and see-through things do not survive as an alpha-tested card. */
export function cardable(o: StandInOptions, g: THREE.BufferGeometry, m: THREE.Material, instances: number): boolean {
  if (m.transparent || m.polygonOffset || !m.depthWrite || m.blending !== THREE.NormalBlending || m.alphaTest > 0) return false;
  if (instances < o.minInstances || triangles(g) < o.minTriangles || Object.keys(g.morphAttributes).length) return false;
  if (!g.boundingBox) g.computeBoundingBox();
  const box = g.boundingBox!;
  return !box.isEmpty() && box.getSize(new THREE.Vector3()).length() / 2 <= o.maxRadius;
}

/** Where a part's picture is in the cards' atlas: u, v of its corner and its width and height (0..1). */
export type CardCell = readonly [number, number, number, number];
/** The cards' pictures: one texture for every card, so every card on the page is one draw (today drew one a part). */
export type CardPictures = { texture: THREE.Texture; add(geometry: THREE.BufferGeometry, material: THREE.Material): CardCell | null };

/** The card: x in [-0.5, 0.5], y in [0, 1], normal straight up so it is lit like the ground cover around it; each
 *  instance's matrix gives its size and footprint (`cardMatrix`). */
export function cardGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

/** Cylindrical billboard: the card turns about its own vertical axis to face the camera (vertex shader, today's), and
 *  reads its own picture's cell of the atlas (`cardCell`, per instance). */
export function cardMaterial(texture: THREE.Texture): THREE.Material {
  const m = new THREE.MeshLambertMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute vec4 cardCell;\n' + shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      vMapUv = cardCell.xy + uv * cardCell.zw;`).replace('#include <project_vertex>', `
      vec4 cardBase = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      vec2 toCam = cameraPosition.xz - cardBase.xz; float len = length(toCam); vec2 f = len > 1e-4 ? toCam / len : vec2(0.0, 1.0);
      float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
      vec4 cardWorld = vec4(cardBase.x + f.y * transformed.x * sx, cardBase.y + transformed.y * sy, cardBase.z - f.x * transformed.x * sx, 1.0);
      vec4 mvPosition = viewMatrix * cardWorld;
      gl_Position = projectionMatrix * mvPosition;`);
  };
  m.customProgramCacheKey = () => 'far-stand-in-card/2';
  return m;
}

const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), one = new THREE.Quaternion();
/** A card's instance matrix for a part (bounding `box`) drawn at `matrix`: at the part's footprint (its box's base
 *  centre), unturned (the shader faces it to the camera), as wide and tall as the part's box. */
export function cardMatrix(box: THREE.Box3, matrix: THREE.Matrix4, out = new THREE.Matrix4()): THREE.Matrix4 {
  matrix.decompose(p, q, s);
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  p.set(c.x, box.min.y, c.z).applyMatrix4(matrix);
  return out.compose(p, one, s.set(Math.max(size.x, size.z, 1e-3) * Math.max(s.x, s.z), Math.max(size.y, 1e-3) * s.y, 1));
}

/** Albedo snapshots of parts from the side, each into its own cell of one transparent atlas, with the page's renderer
 *  (today's rendererSnapshotter, `cell` pixels a side). A full atlas takes no more: those parts keep their detail. */
export function rendererPictures(renderer: THREE.WebGLRenderer, cell = 96, cols = 16): CardPictures {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI)); // physically based materials reflect ambient·albedo/π: π gives the albedo
  const side = cell * cols, pad = 3;
  const target = new THREE.WebGLRenderTarget(side, side, { depthBuffer: true });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  target.texture.generateMipmaps = true;
  target.texture.minFilter = THREE.LinearMipmapLinearFilter;
  let next = 0, cleared = false;
  return {
    texture: target.texture,
    add(geometry, material) {
      if (next >= cols * cols) return null;
      const k = next++, x = (k % cols) * cell, y = Math.floor(k / cols) * cell;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox!, size3 = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const w = Math.max(size3.x, size3.z, 1e-3) / 2, h = Math.max(size3.y, 1e-3) / 2;
      // The cell spans the bounding box exactly: framed edge to edge so picture and card line up.
      Object.assign(camera, { left: -w, right: w, top: h, bottom: -h, near: 0.01, far: Math.max(size3.x, size3.z) * 2 + 10 });
      camera.updateProjectionMatrix();
      camera.position.set(c.x, c.y, c.z + Math.max(size3.x, size3.z) + 5);
      camera.lookAt(c);
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      const previous = renderer.getRenderTarget(), clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
      const autoClear = renderer.autoClear, shadows = renderer.shadowMap.enabled, scissorTest = renderer.getScissorTest();
      try {
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        if (!cleared) (renderer.setScissorTest(false), renderer.clear(), (cleared = true));
        renderer.autoClear = false;
        renderer.shadowMap.enabled = false;
        // Inside a margin, so the atlas's smaller mip levels do not bleed a neighbour into a card.
        target.viewport.set(x + pad, y + pad, cell - 2 * pad, cell - 2 * pad);
        target.scissor.copy(target.viewport);
        target.scissorTest = true;
        renderer.clear();
        renderer.render(scene, camera);
      } finally {
        target.scissorTest = false;
        target.viewport.set(0, 0, side, side);
        renderer.setRenderTarget(previous);
        renderer.setClearColor(clear, alpha);
        renderer.setScissorTest(scissorTest);
        renderer.autoClear = autoClear;
        renderer.shadowMap.enabled = shadows;
        mesh.removeFromParent();
      }
      return [(x + pad) / side, (y + pad) / side, (cell - 2 * pad) / side, (cell - 2 * pad) / side];
    },
  };
}
