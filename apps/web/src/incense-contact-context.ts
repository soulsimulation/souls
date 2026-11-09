// Viewer-only geometry for the qualified authored incense kit. No native authority.
import {stableStringify, type Entity, type StoredDef} from '@souls/world-compiler';
import {INCENSE_CENSER_DEF} from '../../../packages/world-compiler/src/core-kit/incense.ts';
import {expandKitProgram} from '@souls/generators';
import {sha256} from '../../../mars/viewer/engine/core/hash.ts';
import type {IncenseTipContext} from '../../../mars/viewer/app/engine-view/incense-tip-touch.ts';

type Triple = readonly [number, number, number];
export type IncenseWorldPose = {x: number; y: number; z: number; yaw: number; s: number};
export type PreparedIncenseContact = {
  revision: string;
  key: string;
  nativeDef: string;
  tip: Triple;
  tipRadius: number;
  centre: Triple;
  radius: number;
  bowlTop: number;
};
const authored = INCENSE_CENSER_DEF.make;
if (authored?.kind !== 'gen') throw Error('Incense reference must be an authored kit');
const reference = expandKitProgram(authored.args);
const referenceKey = stableStringify(reference);
const paramNames = new Set(Object.keys(INCENSE_CENSER_DEF.params ?? {}));
const finiteTriple = (v: readonly number[]) => v.length === 3 && v.every(Number.isFinite);

/** Restricts the solver to its qualified solid recipe; a new incense tag is not physical proof.
 * Returned dimensions come from this exact definition's authored primitives. */
export function prepareIncenseContact(def: StoredDef, entity: Pick<Entity, 'params' | 'shape' | 'r'>,
  bakedBox: readonly number[], scale: number): PreparedIncenseContact | null {
  if (!def.tags.includes('incense') || !def.tags.includes('hand-operated') || def.tags.includes('fire') ||
    def.make.kind !== 'gen' || def.make.gen !== 'kit/2' || def.extends || entity.shape ||
    def.slots.length || Object.keys(def.components).length || !/^[a-f0-9]{64}$/.test(def.hash) ||
    !finiteTriple(bakedBox) || bakedBox.some(v => v <= 0) || !Number.isFinite(scale) || scale <= 0 ||
    Array.isArray(entity.r) && (entity.r[1] !== 0 || entity.r[2] !== 0) ||
    Object.keys(def.params).some(k => !paramNames.has(k)) ||
    Object.keys(entity.params ?? {}).some(k => !paramNames.has(k))) return null;
  const params: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(def.params)) if (p.default !== undefined) params[k] = p.default;
  Object.assign(params, entity.params ?? {});
  if (Object.values(params).some(v => typeof v === 'number' && !Number.isFinite(v))) return null;
  let kit;
  try {kit = expandKitProgram(def.make.args, params);} catch {return null;}
  if (stableStringify(kit) !== referenceKey) return null;
  const tip = kit.shapes.find(s => s.kind === 'sphere' && s.tint === 'valve' && !s.when);
  const bowl = kit.shapes.find(s => s.kind === 'lathe' && s.tint === 'ceramic' && !s.when);
  if (!tip || !bowl || tip.r === undefined || !bowl.profile?.length) return null;
  const solid = kit.shapes.filter(s => !s.when);
  // The qualified recipe is vertical and centred around its stand; the off-axis stick is included.
  const centre: Triple = [bowl.at[0], 0, bowl.at[2]];
  const radius = Math.max(...solid.map(s => {
    const r = s.kind === 'lathe' ? Math.max(...s.profile!.map(p => p[0])) : s.r!;
    return Math.hypot(s.at[0] - centre[0], s.at[2] - centre[2]) + r;
  }));
  const bowlTop = bowl.at[1] + Math.max(...bowl.profile.map(p => p[1]));
  if (!finiteTriple(tip.at) || !Number.isFinite(radius) || radius <= 0 ||
    !Number.isFinite(bowlTop) || !Number.isFinite(tip.r) || tip.r <= 0) return null;
  const nativeKey = `${def.hash}|${JSON.stringify(entity.params ?? {})}|seen|${bakedBox.map(v => Math.round(v * scale * 10000) / 10000).join(',')}`;
  return {revision: def.hash, key: stableStringify([def.hash, params, entity.shape ?? null]),
    nativeDef: `ew:${def.ref.replace(/[^a-z0-9/@._-]/gi, '').slice(0, 48)}:${sha256(nativeKey).slice(0, 10)}`,
    tip: [tip.at[0], tip.at[1], tip.at[2]], tipRadius: tip.r, centre, radius, bowlTop};
}

/** Same entity-world yaw convention as the authored mesh and native contact adapter. */
export function placeIncenseContact(prepared: PreparedIncenseContact, target: string,
  pose: IncenseWorldPose): IncenseTipContext | null {
  if (!target || ![pose.x, pose.y, pose.z, pose.yaw, pose.s].every(Number.isFinite) || pose.s <= 0) return null;
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  const point = (p: Triple): [number, number, number] => {const [x, y, z] = p.map(v => v * pose.s);
    return [pose.x + x * c + z * s, pose.y + y, pose.z - x * s + z * c];};
  const result = {target, revision: prepared.revision, tip: point(prepared.tip), tipRadius: prepared.tipRadius * pose.s,
    centre: point(prepared.centre), radius: prepared.radius * pose.s, bowlTop: pose.y + prepared.bowlTop * pose.s};
  return [...result.tip, ...result.centre, result.tipRadius, result.radius, result.bowlTop].every(Number.isFinite) ? result : null;
}
