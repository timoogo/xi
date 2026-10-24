import { SHAPES, type ExpressionId } from "bloub-react";
import { DEFAULT_BLOUB_CONFIG } from "./config";
import type { BloubConfig } from "./types";

/** Expressions suited to an identity picked at random (no anger, sadness or fear). */
const SEED_EXPRESSIONS: ExpressionId[] = ["neutre", "attentif", "curieux", "heureux", "fier", "timide", "surpris", "excite"];

/**
 * Deterministic appearance from a 128-bit hex seed. The shape keeps the byte
 * used by the previous engine, so stored seeds keep their silhouette.
 */
export function bloubFromSeed(seed?: string | null): BloubConfig {
  if (!seed || !/^[0-9a-f]{32}$/.test(seed)) return DEFAULT_BLOUB_CONFIG;
  const byte = (i: number) => parseInt(seed.slice(i * 2, i * 2 + 2), 16);
  return { ...DEFAULT_BLOUB_CONFIG, shape: SHAPES[byte(6) % SHAPES.length].id, expression: SEED_EXPRESSIONS[byte(7) % SEED_EXPRESSIONS.length] };
}
