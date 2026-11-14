/**
 * Steps of the `plan-idea` task, shown on /dashboard/konstruktor/idea. Client-safe. The task logs the
 * start and the end of each step in its attempt's history (`xiagent_run`, written as it happens);
 * the page reads them back with the task: a step is shown done only when its end was logged, and the
 * last step only when the task's result is stored. Nothing is inferred from elapsed time.
 */
export const IDEA_STEPS = [
  { key: "intent", label: "Analyse de l’intention" },
  { key: "generate", label: "Génération locale des topics et regroupement" },
  { key: "check", label: "Validation et vérification des correspondances" },
  { key: "preview", label: "Prévisualisation disponible" },
] as const;
export type IdeaStepKey = (typeof IDEA_STEPS)[number]["key"];
export type IdeaStepState = "waiting" | "running" | "done" | "error";
export const STEP_STARTED = "en cours";
export const STEP_DONE = "terminée";
/** The log line of a step boundary (« Analyse de l’intention — en cours. »). */
export const stepMessage = (key: IdeaStepKey, edge: typeof STEP_STARTED | typeof STEP_DONE) => `${IDEA_STEPS.find(step => step.key === key)!.label} — ${edge}.`;

type Log = { message: string };
type Run = { status: string; startedAt: number; finishedAt: number | null; error: string | null; logs: Log[] };
/** What the page knows of the task (the system task view, `GET /api/system-agents/konstruktor/tasks/<id>`). */
export type IdeaTaskView = { state: "pending" | "running" | "done" | "failed"; createdAt: number; updatedAt: number; runAfter: number; attempts: number; maxAttempts: number; message: string | null; result: unknown; runs: Run[] };

/** State of each step from the latest attempt's logs; the step running when the task failed is the one in error. */
export function ideaSteps(view: IdeaTaskView): { key: IdeaStepKey; label: string; state: IdeaStepState }[] {
  const run = view.runs.at(-1);
  const logged = new Set(run?.logs.map(log => log.message) ?? []);
  const failed = view.state === "failed" || (view.state === "pending" && run?.status === "failed");
  let errorShown = false;
  return IDEA_STEPS.map(step => {
    let state: IdeaStepState;
    if (step.key === "preview") state = view.state === "done" ? "done" : "waiting";
    else if (logged.has(stepMessage(step.key, STEP_DONE))) state = "done";
    else if (logged.has(stepMessage(step.key, STEP_STARTED))) state = failed ? "error" : "running";
    else state = "waiting";
    if (state === "error") errorShown = true;
    // A failure before any step started (agent disabled, invalid input): shown on the first step.
    if (failed && !errorShown && step.key === "intent" && state === "waiting") { state = "error"; errorShown = true; }
    return { key: step.key, label: step.label, state };
  });
}

/** Elapsed time of the task: until its last change once finished, else until now. */
export const ideaElapsed = (view: IdeaTaskView, now: number) => Math.max(0, (view.state === "done" || view.state === "failed" ? view.updatedAt : now) - view.createdAt);

/** The task state in words (waiting for the model, retry planned, running, done, failed). */
export function ideaTaskLabel(view: IdeaTaskView, now: number) {
  if (view.state === "done") return "Terminée : prévisualisation prête.";
  if (view.state === "failed") return "Échec.";
  if (view.state === "running") return "En cours sur votre modèle local.";
  if (view.runAfter > now && view.attempts > 0) return `En attente : nouvel essai prévu à ${new Date(view.runAfter).toLocaleTimeString("fr-FR", { timeStyle: "short" })}${view.message ? ` (${view.message})` : ""}.`;
  return "En file d’attente.";
}
