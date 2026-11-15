import * as THREE from 'three';
/** D1: a simple open car drawn at a native ride carrier's pose (a god carousel, or a ferris wheel without gondolas of its
 *  own: the thing itself stays put; the rider is carried by this car, on a wheel fixed to its rim by an arm, #1976). A wheel with hanging gondolas gets none (#2198): its
 *  rider goes round in one of them (gen-mesh/motion.ts rideTurn). Car-local space as the balloon
 *  basket's: origin = floor centre (Core's floorY, where riders stand), +x forward. Presentation only. */
const L = 1.5, W = 1.2, WALL = 0.8, T = 0.06, BAR = 2.3, RAIL = 1.02, RAIL_X = 0.6;
/** #1976: a car on a rim-mounted wheel (the core wheel, server god/rides.ts RIM_DROP) is fixed to the rim point this far
 *  over its floor; an arm from its wheel-side wall to the wheel's plane holds it there while it goes round. */
const RIM_DROP = 0.45;
/** #1976: the arm's length from a car's wheel-side wall (its +x end, Core convention: +x = (cos yaw, sin yaw)) to the plane of
 *  the wheel at `wheel` (world x, z); the car faces into the wheel. Null when the car is not against the wheel (parked at its
 *  home in front of it, where no arm is drawn). Pure. */
export function rimArm(p: readonly number[], yaw: number, wheel: readonly [number, number]): number | null {
  const a = (wheel[0] - p[0]) * Math.cos(yaw) + (wheel[1] - p[2]) * Math.sin(yaw) - L / 2;
  return a > 0.05 && a < 1.5 ? a : null;
}
export class WorldRideCars {
  readonly group = new THREE.Group();
  private cars = new Map<string, THREE.Group>();
  private body = new THREE.MeshStandardMaterial({color: '#c8553d', roughness: 0.7});
  private trim = new THREE.MeshStandardMaterial({color: '#e9e2d0', roughness: 0.6});
  private geo = {floor: new THREE.BoxGeometry(L, T, W), side: new THREE.BoxGeometry(L, WALL, T), end: new THREE.BoxGeometry(T, WALL, W), post: new THREE.BoxGeometry(0.05, BAR - WALL, 0.05), bar: new THREE.BoxGeometry(0.06, 0.06, W),
    rail: new THREE.BoxGeometry(0.05, 0.05, W), railPost: new THREE.BoxGeometry(0.04, RAIL - WALL, 0.04), arm: new THREE.BoxGeometry(1, 0.1, 0.1)};
  private arms = new Map<string, THREE.Mesh>();
  constructor() {this.group.name = 'ride-cars';}
  private build(id: string) {
    const g = new THREE.Group(); g.name = `ride-car:${id}`;
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; g.add(o);};
    add(this.geo.floor, this.body, 0, -T / 2, 0);
    for (const z of [-W / 2, W / 2]) add(this.geo.side, this.body, 0, WALL / 2, z);
    for (const x of [-L / 2, L / 2]) add(this.geo.end, this.body, x, WALL / 2, 0);
    // the hanger: two posts from the side walls' middle up to a bar over the riders' heads (where it hangs from the wheel)
    for (const z of [-W / 2, W / 2]) add(this.geo.post, this.trim, 0, WALL + (BAR - WALL) / 2, z);
    add(this.geo.bar, this.trim, 0, BAR, 0);
    // #1977: a grab rail across the car at the riders' hand height, in front of them (riders face +x), where their hands rest
    add(this.geo.rail, this.trim, RAIL_X, RAIL, 0);
    for (const z of [-W / 2, W / 2]) add(this.geo.railPost, this.trim, RAIL_X, WALL + (RAIL - WALL) / 2, z);
    // #1976: the arm that fixes a wheel's car to its rim (scaled to its length each frame; hidden while parked)
    const arm = new THREE.Mesh(this.geo.arm, this.trim); arm.castShadow = true; arm.visible = false; g.add(arm); this.arms.set(id, arm);
    this.group.add(g); this.cars.set(id, g); return g;
  }
  /** Place one car per carrier (Core convention: rotation.y = -yaw); cars of carriers no longer listed are removed. */
  update(carriers: readonly {id: string; p: readonly number[]; yaw: number; wheel?: readonly [number, number]}[]) {
    const keep = new Set<string>();
    for (const c of carriers) {
      keep.add(c.id); const g = this.cars.get(c.id) ?? this.build(c.id); g.position.set(c.p[0], c.p[1], c.p[2]); g.rotation.y = -c.yaw; g.visible = true;
      const arm = this.arms.get(c.id)!, len = c.wheel ? rimArm(c.p, c.yaw, c.wheel) : null;
      arm.visible = len !== null; if (len !== null) {arm.scale.x = len; arm.position.set(L / 2 + len / 2, RIM_DROP, 0);}
    }
    for (const [id, g] of this.cars) if (!keep.has(id)) {this.group.remove(g); this.cars.delete(id); this.arms.delete(id);}
  }
  dispose() {for (const g of Object.values(this.geo)) g.dispose(); this.body.dispose(); this.trim.dispose(); this.group.clear(); this.cars.clear(); this.arms.clear();}
}
