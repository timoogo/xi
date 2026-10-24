import type { ExpressionId, ShapeId, StateId } from "bloub-react";
import type { BloubActivity } from "@/lib/bloub/types";

// Typed records: a catalog id added by the library fails compilation until labelled.
export const SHAPE_LABELS: Record<ShapeId, string> = {
  cercle: "Cercle", galet: "Galet", squircle: "Squircle", capsule: "Capsule", triangle: "Triangle", hexagone: "Hexagone", nuage: "Nuage", goutte: "Goutte",
};

export const EXPRESSION_LABELS: Record<ExpressionId, string> = {
  neutre: "Neutre", attentif: "Attentif", surpris: "Surpris", excite: "Excité", heureux: "Heureux", hilare: "Hilare", colere: "En colère", triste: "Triste",
  effraye: "Effrayé", mefiant: "Méfiant", confus: "Confus", curieux: "Curieux", fier: "Fier", timide: "Timide", blase: "Blasé", somnolent: "Somnolent",
};

export const ANIMATION_LABELS: Record<StateId, string> = {
  idle: "Repos", thinking: "Réflexion", wink: "Clin d’œil", wide: "Yeux écarquillés", alert: "Alerte", notify: "Notification", exclaim: "Exclamation",
  sleep: "Sommeil", egg: "Œuf", hexagon: "Hexagone", play: "Lecture", orbit: "Orbite", burst: "Éclatement", comet: "Comète", swirl: "Tourbillon",
};

export const ACTIVITY_LABELS: Record<BloubActivity, string> = {
  sleeping: "En veille", idle: "Disponible", working: "Au travail", unavailable: "Indisponible",
};
