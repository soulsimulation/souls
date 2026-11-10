import type { DefInput } from '../schemas.ts';
import creatures from './creatures.json' with { type: 'json' };
const rabbit = structuredClone(creatures.find(d => d.name === 'core-rabbit')!) as unknown as DefInput;
const args = structuredClone((rabbit.make as { args: Record<string, unknown> }).args) as { shapes: Record<string, unknown>[]; gait: string };
for (const s of args.shapes) { if (typeof s.segments === 'number') s.segments = Math.min(3, s.segments); if (s.role && s.role !== 'head') { delete s.role; delete s.pivot; } }
export const GARDEN_RABBIT: DefInput = { ...rabbit, name: 'core-garden-rabbit', version: 1,
 description: 'An opt-in garden rabbit at a fixed authored feeding place. Initially idle and unfed; one completed native feeding from a nearby supplied rabbit-feed box changes this SAME animal to fed and resting, with feeder/source history. Existing kit rabbit geometry and idle/sleep presentation; no new animal AI, roaming body, hunger decay or physiological timing. Inspect rabbitCare facts and normal catalog/live fed state.',
 tags: ['animal', 'rabbit', 'garden-rabbit'], synonyms: ['garden rabbit', 'pet rabbit'],
 params: { ...rabbit.params, behavior: { type: 'enum', values: ['idle', 'sleep'], default: 'idle', doc: 'Fixed-place idle before feeding; existing sleep/rest presentation afterward.' } },
 make: { kind: 'gen', gen: 'kit/2', args } as DefInput['make'],
 components: {},
 state: { fed: { type: 'bool', default: false }, feeder: { type: 'string', max: 80, default: '' }, source: { type: 'string', max: 160, default: '' } }, actions: [], slots: [] };
export const RABBIT_FEED: DefInput = { schema: 'def/1', name: 'core-rabbit-feed', version: 1,
 description: 'Three supplied feed portions for opt-in garden rabbits. Choose a real unfed garden rabbit by exact ID in text, within six metres on the same floor. Three completed native feed seconds atomically consume one whole portion and change that SAME rabbit to fed/resting. Empty hands, current access and unchanged source/target/body required. Inspect rabbitCare for remaining stock and completed history. Existing bread prop is an approximate feed proxy, not borrowed item custody. No feed production, hunger clock or new animal locomotion.',
 tags: ['garden', 'feed'], synonyms: ['rabbit feed', 'feed box'], params: {}, palette: { wood: '#8c6e44', feed: '#cda967' }, size: { box: [.6, .55, .5] },
 make: { kind: 'gen', gen: 'kit/2', args: { round: 0, shapes: [
 { kind: 'box', at: [0,.05,0], size: [.6,.1,.5], tint: 'wood' },
 { kind: 'box', at: [-.27,.28,0], size: [.06,.46,.5], tint: 'wood' }, { kind: 'box', at: [.27,.28,0], size: [.06,.46,.5], tint: 'wood' },
 { kind: 'box', at: [0,.28,-.22], size: [.48,.46,.06], tint: 'wood' }, { kind: 'box', at: [0,.15,.22], size: [.48,.2,.06], tint: 'wood' },
 ...[1,2,3].map((n,i)=>({ kind: 'box', at: [-.16+i*.16,.18,0], size: [.13,.17,.32], tint: 'feed', when: `@portions>=${n}` }))
 ] } } as DefInput['make'],
 components: {}, slots: [],
 state: { portions: { type: 'number', min: 0, max: 3, default: 3 }, feedings: { type: 'number', min: 0, max: 1e9, default: 0 }, lastBy: { type: 'string', max: 80, default: '' }, lastRabbit: { type: 'string', max: 160, default: '' }, lastReceipt: { type: 'string', max: 100, default: '' }, lastCompletedTick: { type: 'number', min: -1, max: 1e12, default: -1 }, workSeconds: { type: 'number', min: 3, max: 3, default: 3 } },
 actions: [{ name: 'feed-rabbit', label: 'Offer one supplied portion to an unfed garden rabbit (3 native seconds)', params: { text: { type: 'string', max: 160, default: '', doc: 'Choose a rabbit for success; blank gives a useful refusal. Exact ID or ordinary reference of an unfed garden rabbit within six metres.' } }, then: [{ op: 'set', field: 'workSeconds', value: 3 }] }] };
export const RABBIT_CARE_DEFS: DefInput[] = [RABBIT_FEED, GARDEN_RABBIT];
