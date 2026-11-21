// Far scattered things drawn as flat stand-ins (#3786), today's WorldFarStandIns (apps/web/src/WorldFarStandIns.ts,
// copied, not imported), on the phone tier as today. A part of a model many things share (trees, plants, benches, small
// things), small enough and of enough triangles, is drawn past `cardRadiusPx` CSS pixels of radius as one camera-facing
// card (two triangles, no shadow): a snapshot of that part taken once from the side (albedo only, transparent
// background), tinted with the instance's own colour, standing on the part's footprint. The thing layer moves a part
// between its model batch and its card batch like its other bands (things.ts), so far woods keep their silhouette.
import * as THREE from 'three';

export type StandInOptions = { cardRadiusPx: number; minInstances: number; minTriangles: number; maxRadius: number; snapshotsPerFrame: number };
/** Today's PHONE_STAND_INS. */
export const PHONE_STAND_INS: StandInOptions = Object.freeze({ cardRadiusPx: 7, minInstances: 12, minTriangles: 40, maxRadius: 6, snapshotsPerFrame: 2 });
/** Renders an albedo snapshot of one part (side view, transparent background); null if impossible. */
export type Snapshotter = (geometry: THREE.BufferGeometry, material: THREE.Material) => THREE.Texture | null;

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

/** A unit card: x in [-0.5, 0.5], y in [0, 1] scaled to the part's box, normal straight up so it is lit like the
 *  ground cover around it. */
export function cardGeometry(box: THREE.Box3): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const size = box.getSize(new THREE.Vector3()), w = Math.max(size.x, size.z, 1e-3), h = Math.max(size.y, 1e-3);
  g.scale(w, h, 1).translate(0, box.min.y, 0);
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

/** Cylindrical billboard: the card turns about its own vertical axis to face the camera (vertex shader). */
export function cardMaterial(texture: THREE.Texture): THREE.Material {
  const m = new THREE.MeshLambertMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      vec4 cardBase = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      vec2 toCam = cameraPosition.xz - cardBase.xz; float len = length(toCam); vec2 f = len > 1e-4 ? toCam / len : vec2(0.0, 1.0);
      float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
      vec4 cardWorld = vec4(cardBase.x + f.y * transformed.x * sx, cardBase.y + transformed.y * sy, cardBase.z - f.x * transformed.x * sx, 1.0);
      vec4 mvPosition = viewMatrix * cardWorld;
      gl_Position = projectionMatrix * mvPosition;`);
  };
  m.customProgramCacheKey = () => 'far-stand-in-card/1';
  return m;
}

const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), one = new THREE.Quaternion();
/** A card's instance matrix for a part drawn at `matrix`: at the part's footprint (its box's base centre), unturned
 *  (the shader faces it to the camera), scaled as the part is. */
export function cardMatrix(box: THREE.Box3, matrix: THREE.Matrix4, out = new THREE.Matrix4()): THREE.Matrix4 {
  matrix.decompose(p, q, s);
  const c = box.getCenter(new THREE.Vector3());
  p.set(c.x, 0, c.z).applyMatrix4(matrix);
  return out.compose(p, one, s.set(Math.max(s.x, s.z), s.y, 1));
}

/** Albedo snapshot of one part from the side into a small transparent texture, with the page's renderer (today's
 *  rendererSnapshotter). */
export function rendererSnapshotter(renderer: THREE.WebGLRenderer, size = 96): Snapshotter {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI)); // physically based materials reflect ambient·albedo/π: π gives the albedo
  return (geometry, material) => {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!, size3 = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const w = Math.max(size3.x, size3.z, 1e-3) / 2, h = Math.max(size3.y, 1e-3) / 2;
    // The card spans the bounding box exactly: frame it edge to edge so texture and card line up.
    Object.assign(camera, { left: -w, right: w, top: h, bottom: -h, near: 0.01, far: Math.max(size3.x, size3.z) * 2 + 10 });
    camera.updateProjectionMatrix();
    camera.position.set(c.x, c.y, c.z + Math.max(size3.x, size3.z) + 5);
    camera.lookAt(c);
    const target = new THREE.WebGLRenderTarget(size, Math.max(16, Math.round(size * Math.min(2, h / w))), { depthBuffer: true });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    target.texture.generateMipmaps = true;
    target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    const previous = renderer.getRenderTarget(), clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
    const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    const autoClear = renderer.autoClear, shadows = renderer.shadowMap.enabled;
    try {
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.shadowMap.enabled = false;
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previous);
      renderer.setClearColor(clear, alpha);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      renderer.autoClear = autoClear;
      renderer.shadowMap.enabled = shadows;
      mesh.removeFromParent();
    }
    target.texture.userData.dispose = () => target.dispose();
    return target.texture;
  };
}
