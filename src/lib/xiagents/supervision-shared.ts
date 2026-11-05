/** Client-safe part of the supervision (supervision.ts): views, states, labels and URLs. */
export const SUPERVISION_VIEWS = ["calendar", "queue", "activity"] as const;
export type SupervisionView = typeof SUPERVISION_VIEWS[number];
export const SUPERVISION_VIEW_LABELS: Record<SupervisionView, string> = { calendar: "Calendrier", queue: "Queue éditoriale", activity: "Exécutions" };
/** What an execution amounted to: "empty" (nothing relevant to do) is not an error. */
export const ACTIVITY_STATES = ["done", "empty", "waiting", "retrying", "running", "error"] as const;
export type ActivityState = typeof ACTIVITY_STATES[number];
export const ACTIVITY_STATE_LABELS: Record<ActivityState, string> = {
  done: "Réussie", empty: "Sans suite (aucune actualité pertinente)", waiting: "En attente", retrying: "Nouvel essai prévu", running: "En cours", error: "En erreur",
};
export const QUEUE_STATES = ["ready", "published", "withdrawn", "expired"] as const;
export type QueueStateValue = typeof QUEUE_STATES[number];
export const QUEUE_STATE_LABELS: Record<QueueStateValue, string> = { ready: "Prêt", published: "Publié", withdrawn: "Retiré", expired: "Expiré" };

export type SupervisionParams = Partial<Record<"view" | "agent" | "topic" | "story" | "month" | "date" | "tz" | "from" | "to" | "state" | "before", string>>;
/** The page URL with `changes` applied (undefined removes a parameter; changing a filter drops the page cursor). */
export function supervisionHref(current: SupervisionParams, changes: SupervisionParams) {
  const next = { ...current, ...("before" in changes ? {} : { before: undefined }), ...changes };
  const params = new URLSearchParams(Object.entries(next).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
  const search = params.toString();
  return `/dashboard/supervision${search ? `?${search}` : ""}`;
}
