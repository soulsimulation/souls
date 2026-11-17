// Loading kinds and case files from disk, for Node. The rules themselves (rules.ts) read nothing.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Entry, Input, Verdict } from './rules.ts';

export const PACKAGE = resolve(import.meta.dirname, '..');
export const ROOT = resolve(PACKAGE, '../..');
export const CASES = join(PACKAGE, 'cases');
/** Where kinds come from: the published entries, then the test kinds only cases use. */
export const KIND_DIRS = [join(ROOT, 'content/kinds'), join(CASES, 'kinds')];

export type Case = Omit<Input, 'kinds'> & { name: string; expect: Partial<Verdict> & Record<string, unknown> };

function jsonFiles(dir: string, deep: boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory() && deep) out.push(...jsonFiles(join(dir, e.name), deep));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(join(dir, e.name));
  }
  return out;
}

export function loadKinds(dirs: string[] = KIND_DIRS): Record<string, Entry> {
  const kinds: Record<string, Entry> = {};
  for (const dir of dirs) {
    for (const file of jsonFiles(dir, true)) {
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      if (entry.format !== 'souls-entry/1') continue;
      if (kinds[entry.kind]) throw new Error(`${file}: kind ${entry.kind} defined twice`);
      kinds[entry.kind] = entry;
    }
  }
  return kinds;
}

/** Every case file directly in `dir` (not its kinds/ folder), as [file, case]. */
export function loadCases(dir: string = CASES): [string, Case][] {
  const out: [string, Case][] = [];
  for (const file of jsonFiles(dir, false)) {
    const doc = parse(readFileSync(file, 'utf8'));
    if (doc.format !== 'souls-form-cases/1') throw new Error(`${file}: format is not souls-form-cases/1`);
    for (const c of doc.cases) out.push([file, c]);
  }
  return out;
}

export type EffectStep = { act: Input["act"]; actor?: string; receipt: string; draw?: number[]; expect?: Record<string, unknown> };
export type EffectCase = { name: string; state: Input['state']; do: EffectStep[]; after?: Record<string, unknown> };

/** Every effect case in `dir` (souls-effect-cases/1), as [file, case]. */
export function loadEffectCases(dir: string = join(CASES, 'effects')): [string, EffectCase][] {
  const out: [string, EffectCase][] = [];
  for (const file of jsonFiles(dir, false)) {
    const doc = parse(readFileSync(file, 'utf8'));
    if (doc.format !== 'souls-effect-cases/1') throw new Error(`${file}: format is not souls-effect-cases/1`);
    for (const c of doc.cases) out.push([file, c]);
  }
  return out;
}

/** Deep equality of JSON values; object key order does not matter, array order does. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The keys of `expect` that the verdict does not match (each key compared whole). */
export function mismatches(expect: Record<string, unknown>, verdict: Verdict | Record<string, unknown>): string[] {
  return Object.keys(expect).filter((k) => !same(expect[k], (verdict as Record<string, unknown>)[k]));
}

export type TimedCase = {
  name: string;
  kind: string;
  field: string;
  stored: unknown;
  values: [number | bigint, unknown][];
  crossings: { at_least?: number | bigint; at_most?: number | bigint; from_us: number | bigint; expect: unknown }[];
};

/** JSON with every whole number beyond a safe integer read as a big integer, as T0's encoding reads it (SA-F5a). */
export function parse(text: string): any {
  const big = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '') ? BigInt(context!.source!) : value;
  return JSON.parse(text, big as (key: string, value: unknown) => unknown);
}

/** Every timed-value case in `dir` (souls-timed-cases/1), as [file, case]. */
export function loadTimedCases(dir: string = join(CASES, 'timed')): [string, TimedCase][] {
  const out: [string, TimedCase][] = [];
  for (const file of jsonFiles(dir, false)) {
    const doc = parse(readFileSync(file, 'utf8'));
    if (doc.format !== 'souls-timed-cases/1') throw new Error(`${file}: format is not souls-timed-cases/1`);
    for (const c of doc.cases) out.push([file, c]);
  }
  return out;
}
