// Looks applied to a thing's parts on the v2 page (#3871): today's `placeParts` (apps/web/src/gen-mesh/vocab-look.ts,
// SA-D1a/SA-D2) on a picture from shape.ts, whose role groups are the parts a looks table names. A part is moved
// (rotate, slide), stretched (scale), shown or hidden (show, pick, flame), recoloured (tint) and lit (glow: its glowing
// material's light, in permille of the part's own) from its rest pose, so the same state always gives the same picture.
// A `grow` row draws the planter's plants (plants.ts) at that stage, bowed by a `wilt` row. Steam and sound rows are
// left to the page's effects and sound.
import * as THREE from 'three';
import type { Placement } from './looks.ts';
import { plantGroup, posePlants, type PlantGroup, type PlantLook } from './plants.ts';

/** A material changed for a look, shared by every part with the same source material and the same look. */
const variants = new Map<string, THREE.Material>();
function variant(m: THREE.Material, key: string, edit: (m: THREE.MeshStandardMaterial) => void): THREE.Material {
  const k = `${m.uuid}|${key}`;
  let v = variants.get(k);
  if (!v) {
    v = m.clone();
    edit(v as THREE.MeshStandardMaterial);
    variants.set(k, v);
  }
  return v;
}

type Rest = { rot: number[]; pos: number[]; scale: number[]; visible: boolean };
const tint = new THREE.Color();

/** A whole number from a string (FNV-1a): the plants' seed from the thing's id, the same on every viewer. */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) (h ^= id.charCodeAt(i)), (h = Math.imul(h, 16777619));
  return h >>> 0;
}

/** Places each part a placement names, from its rest pose; `id` seeds the plants a `grow` row draws. */
export function placeParts(root: THREE.Object3D, placed: Record<string, Placement>, id: string): void {
  let growth: number | undefined, wilt = 0;
  root.traverse((o) => {
    const p = placed[o.userData.role as string];
    if (!p) return;
    const rest = (o.userData.looksRest ??= { rot: [o.rotation.x, o.rotation.y, o.rotation.z], pos: o.position.toArray(), scale: o.scale.toArray(), visible: o.visible }) as Rest;
    if (p.growth_permille !== undefined) growth = p.growth_permille;
    if (p.wilt_permille !== undefined) wilt = p.wilt_permille;
    const d = Math.PI / 180000;
    o.rotation.set(rest.rot[0] + (p.rotate_mdeg?.[0] ?? 0) * d, rest.rot[1] + (p.rotate_mdeg?.[1] ?? 0) * d, rest.rot[2] + (p.rotate_mdeg?.[2] ?? 0) * d);
    o.position.set(rest.pos[0] + (p.slide_mm?.[0] ?? 0) / 1000, rest.pos[1] + (p.slide_mm?.[1] ?? 0) / 1000, rest.pos[2] + (p.slide_mm?.[2] ?? 0) / 1000);
    o.scale.set(rest.scale[0] * (p.scale_permille?.[0] ?? 1000) / 1000, rest.scale[1] * (p.scale_permille?.[1] ?? 1000) / 1000, rest.scale[2] * (p.scale_permille?.[2] ?? 1000) / 1000);
    o.visible = p.show === undefined ? rest.visible : p.show;
    if (p.flame_permille !== undefined) { const f = p.flame_permille / 1000; o.visible = f > 0; o.scale.set(rest.scale[0] * f, rest.scale[1] * f, rest.scale[2] * f); }
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      const base = (mesh.userData.looksBase ??= mesh.material) as THREE.MeshStandardMaterial;
      if (p.glow_permille === undefined && !p.tint) return void (mesh.material = base);
      mesh.material = variant(base, `table:${p.glow_permille ?? ''}:${p.tint ?? ''}`, (x) => {
        if (p.glow_permille !== undefined && x.emissive) x.emissiveIntensity *= p.glow_permille / 1000;
        if (p.tint) x.color.copy(tint.set(p.tint));
      });
    });
  });
  // SA-D2: a grow row's plants, at its stage (0 seed ... 4000 fruiting) and bowed as they wilt
  let plants = root.children.find((c) => c.name === 'plant growth') as PlantGroup | undefined;
  if (growth === undefined) return void (plants && (plants.visible = false));
  const look: PlantLook = { g: Math.min(4, growth / 1000), w: Math.min(1, wilt / 1000), m: 1 };
  if (!plants) root.add((plants = plantGroup(seedOf(id), look)));
  else posePlants(plants, look);
  plants.visible = true;
}
