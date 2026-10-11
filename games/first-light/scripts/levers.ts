// games/first-light/scripts/levers.ts — the six foundry levers.
//
// One script per engine language, each carrying exactly one top-tier write
// grant: field.write.<domain>. The host loads them progressively as the
// player's attunement crosses its six thresholds — graduated authorship
// made mechanical: the runtime's grant mechanism gates the endgame, and the
// game defines the tiers.
//
// In hand: E grabs/releases the nearest awake lever; Left/Right adjusts it
// while held. Each adjustment writes its domain live through
// caps.field.set and the composed world re-derives downstream — the causal
// chain from parameter to world, made visible. The handle rises/falls with
// the value so the hand sees what it changed.

import type { Caps, CapabilityName, ScriptDef, SpawnBody } from '../../../src/script/index.js';
import { LEVER_POS, LEVER_SPECS, type LeverSpec } from '../shared.js';

const BASE_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'world.state',
  'events', 'audio', 'log', 'field.read', 'probe',
];

/** Grants for lever i: the perception base plus its one domain write. */
export function leverGrants(i: number): CapabilityName[] {
  const spec = LEVER_SPECS[i];
  return [...BASE_GRANTS, `field.write.${spec.domain}` as CapabilityName];
}

/** Apply one adjustment step to a lever value (pure, testable). */
export function leverStep(spec: LeverSpec, value: number, dir: -1 | 1): number {
  const nv = value + dir * spec.step;
  return Math.max(spec.min, Math.min(spec.max, nv));
}

function makeLeverScript(i: number): ScriptDef {
  const spec = LEVER_SPECS[i];
  return {
    name: `fl:lever:${spec.domain}`,

    start(caps: Caps): void {
      const [x, , z] = LEVER_POS[i];
      const ground = caps.probe.ground(x, z);
      // The wake ring: this lever is awake — its language's hand is live.
      caps.world.spawn(`lever-ring:${i}`, {
        position: [x, ground + 0.25, z],
        tag: 'lever',
        body: {
          geometry: { kind: 'torus', radius: 1.7, tube: 0.12, detail: 20 },
          material: {
            baseColor: [0.55, 0.9, 1.0] as [number, number, number],
            effects: ['pulse'] as Array<'pulse'>,
            unlit: true,
          },
        },
      });
      caps.world.setState(`foundry:unlocked:${i}`, 1);
      const params = caps.field.params() as Record<string, Record<string, number>>;
      caps.world.setState(`foundry:val:${i}`, params[spec.domain][spec.key]);
      caps.events.on('input:adjust', (data) => {
        const held = (caps.world.state('foundry:held') as number | undefined) ?? -1;
        if (held !== i) return;
        const d = (data as { d?: unknown }).d;
        const dir = d === 1 ? 1 : d === -1 ? -1 : 0;
        if (!dir) return;
        const cur = (caps.world.state(`foundry:val:${i}`) as number | undefined)
          ?? (caps.field.params() as Record<string, Record<string, number>>)[spec.domain][spec.key];
        const nv = leverStep(spec, cur, dir as -1 | 1);
        if (nv === cur) return;
        // The write itself: one domain, one key, live.
        caps.field.set(spec.domain, { [spec.key]: nv });
        caps.world.setState(`foundry:val:${i}`, nv);
        // The handle shows the value: risen with the parameter.
        const h = caps.world.find(`lever-handle:${i}`);
        if (h) {
          const tr = h.getTransform();
          const frac = (nv - spec.min) / (spec.max - spec.min);
          h.setTransform({
            ...tr,
            position: [x, ground + 2.0 + frac * 1.6, z],
          });
        }
        caps.audio.note({
          t: 0, dur: 0.25,
          freq: 330 + 440 * ((nv - spec.min) / (spec.max - spec.min)),
          kind: 'tone', gain: 0.25,
        });
        caps.events.emit('lever:moved', {
          index: i, domain: spec.domain, key: spec.key,
          value: nv, label: spec.label,
        });
      });
    },

    update(_caps: Caps, _dt: number, _t: number): void {
      void _caps; void _dt; void _t;
    },
  };
}

/** The six lever scripts, in threshold order (TypeScript first). */
export const leverScripts: ScriptDef[] = LEVER_SPECS.map((_, i) => makeLeverScript(i));
