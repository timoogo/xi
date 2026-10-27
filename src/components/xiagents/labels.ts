import type { Pause } from "@/lib/xiagents/schedule";

/** Labels shared by the ΞAgent page's summary and its detailed panels, so both say the same thing. */
export const CANDIDATE: Record<string, string> = { evaluating: "En cours d’évaluation", accepted: "Retenu", held: "En attente", rejected: "Rejeté", merged: "Fusionné", drafted: "Brouillon rédigé", published: "Publié" };
export const LANE: Record<string, string> = { night: "fenêtre nocturne", immediate: "alerte majeure", weekly: "bilan hebdomadaire" };
export const OUTCOME: Record<string, string> = { ok: "Collecte réussie", "not-modified": "Inchangé (304)", error: "Erreur", robots: "Refusé par robots.txt" };

/** The agent's mode as the owner controls it (Pilotage); `when` formats the scheduled resume. */
export function agentMode(state: { active: boolean; enabled: boolean; paused: boolean; pause: Pause | null }, when: (iso: string) => string) {
  if (!state.active) return "ΞAgent désactivé";
  if (!state.enabled) return "Veille désactivée";
  if (state.paused) return state.pause?.resumeAt ? `En pause jusqu’au ${when(state.pause.resumeAt)}` : "En pause (durée indéterminée)";
  return "Automatique";
}
