import { COLOR_BY_ID, DEFAULT_COLOR, DEFAULT_EXPRESSION, DEFAULT_SHAPE, EXPRESSION_BY_ID, SHAPE_BY_ID, type ColorId, type ExpressionId, type ShapeId } from "bloub-react";
import { z } from "zod";
import type { BloubConfig } from "./types";

const catalogId = <T extends string>(catalog: Map<string, unknown>) => z.string().refine(id => catalog.has(id), "Identifiant inconnu du catalogue Bloub.").transform(id => id as T);

/** Strict schema for writes: catalog ids only, unknown fields rejected. */
export const bloubConfigSchema = z.object({
  version: z.literal(1),
  shape: catalogId<ShapeId>(SHAPE_BY_ID),
  expression: catalogId<ExpressionId>(EXPRESSION_BY_ID),
  color: catalogId<ColorId>(COLOR_BY_ID),
}).strict();

/** MVP appearance: black body (the library default ink) and white eyes. */
export const DEFAULT_BLOUB_CONFIG: BloubConfig = { version: 1, shape: DEFAULT_SHAPE, expression: DEFAULT_EXPRESSION, color: DEFAULT_COLOR };

export const sameBloubConfig = (a: BloubConfig, b: BloubConfig) => a.shape === b.shape && a.expression === b.expression && a.color === b.color;
