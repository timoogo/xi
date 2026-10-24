import type { ColorId, ExpressionId, ShapeId } from "bloub-react";

/**
 * Persisted appearance of a Bloub, independent of any application concept.
 * Ids come from the bloub-react catalogs; `version` gates future migrations.
 */
export type BloubConfig = { version: 1; shape: ShapeId; expression: ExpressionId; color: ColorId };

/**
 * Activity vocabulary rendered by the avatar. The host application decides which
 * activity applies; this module only decides how each one looks.
 */
export const BLOUB_ACTIVITIES = ["sleeping", "idle", "working", "unavailable"] as const;
export type BloubActivity = (typeof BLOUB_ACTIVITIES)[number];
