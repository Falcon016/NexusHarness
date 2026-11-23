import type { MeshTier } from '../config/schema.js';

/**
 * How much model a piece of work needs. Three tiers, by size: a small model reads, searches and summarises
 * several times faster than a large one and does it as well, so the large ones are kept for the work that
 * needs them.
 */

export const TIERS: MeshTier[] = ['fast', 'standard', 'strong'];
export const tierRank = (t: MeshTier) => TIERS.indexOf(t);
export const nextTier = (t: MeshTier): MeshTier | undefined => TIERS[tierRank(t) + 1];

/** Billions of parameters from a model name: `qwen3-27b-iq3s` → 27, `qwen3-30b-a3b` → 30, `phi-4` → none. */
export function billionsFromName(id: string): number | undefined {
  let best: number | undefined;
  for (const m of id.toLowerCase().matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n < 2000) best = Math.max(best ?? 0, n);
  }
  return best;
}

/** The tier a model is in: under 10B fast, under 22B standard, the rest strong. Unknown sizes count as standard. */
export function tierOf(id: string, params?: number): MeshTier {
  const b = params ? params / 1e9 : billionsFromName(id);
  if (b === undefined) return 'standard';
  return b < 10 ? 'fast' : b < 22 ? 'standard' : 'strong';
}

const STRONG =
  /\b(debug|root cause|why (does|is|did)|design|architect|refactor|optimi[sz]e|race|deadlock|concurren|security|vulnerab|prove|plan|algorithm|migrat|rewrite|implement)/i;
const FAST =
  /\b(find|list|search|grep|locate|look up|read|summari[sz]e|count|collect|gather|check (whether|if)|which files|what (is|are|does)|run (the )?(tests?|build|linter)|extract|map (out )?the)/i;

/**
 * A first guess at the tier a task needs, from how it is worded. The main agent can name one instead, and a
 * task that gets stuck moves up a tier on its own, so a wrong guess costs little.
 */
export function classifyTask(prompt: string): MeshTier {
  if (STRONG.test(prompt)) return 'strong';
  if (FAST.test(prompt)) return 'fast';
  return 'standard';
}
