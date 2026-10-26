"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WatchDiagnostics } from "@/lib/watch/diagnostics";
import type { FormatOverrides, FormatSettings } from "@/lib/watch/format";

type Act = (task: () => Promise<unknown>, success: string) => Promise<void>;
type Send = (url: string, method: "POST" | "PATCH", data: unknown) => Promise<unknown>;
const selectClass = "rounded-md border bg-background px-3 py-2";
const date = (value: string | null) => (value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }) : "—");
const DECISION: Record<string, string> = { published: "Publiée", deferred: "Reportée", abandoned: "Abandonnée", skipped: "Non publiée", selected: "Retenue pour le bilan" };

const NUMBERS: [keyof FormatSettings, string, number, number][] = [
  ["maxPostChars", "Longueur maximale d’un post (caractères)", 50, 5_000],
  ["maxThreadMessageChars", "Longueur maximale d’un message de thread (caractères)", 50, 5_000],
  ["minThreadMessages", "Messages par thread : minimum", 2, 10],
  ["maxThreadMessages", "Messages par thread : maximum", 2, 10],
  ["targetPostMin", "Longueur cible d’un post : de", 50, 5_000],
  ["targetPostMax", "Longueur cible d’un post : à", 50, 5_000],
  ["correctionAttempts", "Tentatives de correction du format", 0, 5],
];
const SWITCHES: [keyof FormatSettings, string][] = [["threads", "Génération de threads"], ["autoFormat", "Choix automatique post / thread"]];

/** One sentence of the limits in force. */
export const describeFormat = (format: FormatSettings) =>
  `post ≤ ${format.maxPostChars} caractères (cible ${format.targetPostMin}–${format.targetPostMax}) ; ${format.threads ? `threads de ${format.minThreadMessages} à ${format.maxThreadMessages} messages ≤ ${format.maxThreadMessageChars} caractères chacun, ${format.autoFormat ? "format choisi automatiquement" : "posts seulement en automatique"}` : "threads désactivés"} ; ${format.correctionAttempts} correction(s) au plus.`;

/**
 * « Publications » section of a ΞAgent: manual or autonomous mode, visibility, frequency ceilings,
 * format limits (empty field = the account's global limit), weekly review, then the drafting
 * failures and the publication decisions. Saved with the watch policy (same revision).
 */
export function PublicationsSettings({ agentId, data, busy, act, send }: { agentId: string; data: WatchDiagnostics; busy: boolean; act: Act; send: Send }) {
  const { watch, format } = data;
  const [policy, setPolicy] = useState(watch.policy);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const overrides: FormatOverrides = policy.format ?? {};
  const setOverride = (key: keyof FormatSettings, value: number | boolean | undefined) => {
    const next: Record<string, unknown> = { ...overrides };
    if (value === undefined) delete next[key]; else next[key] = value;
    setPolicy({ ...policy, format: next as FormatOverrides });
  };
  const needsConfirmation = policy.visibility === "public" && !watch.publicConfirmedAt;
  const save = () => act(() => send(`/api/xiagents/${agentId}/watch`, "PATCH", { revision: watch.revision, policy, ...(needsConfirmation && confirmPublic ? { confirmPublic: true } : {}) }), "Paramètres de publication enregistrés.");
  const number = (key: "maxPerDay" | "minIntervalMinutes" | "maxImmediatePerDay", label: string, min: number, max: number) =>
    <label className="grid gap-1 text-sm">{label}<Input type="number" min={min} max={max} required value={policy[key]} onChange={event => setPolicy({ ...policy, [key]: Number(event.target.value) })} /></label>;
  const failedDrafts = data.jobs.filter(job => job.kind === "draft-candidate" && job.state === "failed");

  return <section aria-labelledby="publications-title" className="space-y-3">
    <h3 id="publications-title" className="font-semibold">Publications</h3>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="space-y-3">
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 font-medium">Mode de publication</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name={`mode-${agentId}`} checked={!policy.autoPublish} onChange={() => setPolicy({ ...policy, autoPublish: false })} /> Manuel : chaque brouillon attend votre approbation</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name={`mode-${agentId}`} checked={policy.autoPublish} onChange={() => setPolicy({ ...policy, autoPublish: true })} /> Mode autonome : publier automatiquement les brouillons validés</label>
          <label className="grid gap-1 text-sm">Visibilité des publications automatiques<select className={selectClass} value={policy.visibility} onChange={event => { setPolicy({ ...policy, visibility: event.target.value as "private" | "public" }); setConfirmPublic(false); }}><option value="private">Privé (visible par vous seul)</option><option value="public">Public</option></select></label>
          {needsConfirmation && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmPublic} onChange={event => setConfirmPublic(event.target.checked)} />Je confirme que ce ΞAgent pourra publier automatiquement des contenus publics, visibles par tous les utilisateurs de Ξ, sans relecture individuelle.</label>}
          <p className="text-xs text-muted-foreground">Le mode autonome publie seulement les brouillons qui ont passé toutes les vérifications (sources, citations, chiffres, limites, doublons, plafonds, calendrier), et rien tant que l’opérateur n’a pas autorisé la publication automatique sur le worker ; le public exige en plus son autorisation distincte.</p>
        </fieldset>
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 font-medium">Fréquence et horaires</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {number("maxPerDay", "Plafond de publications réelles (24 h)", 1, 24)}
            {number("minIntervalMinutes", "Intervalle minimal (minutes)", 15, 10_080)}
            {number("maxImmediatePerDay", "Plafond d’alertes immédiates (24 h)", 0, 5)}
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.weeklyReview !== false} onChange={event => setPolicy({ ...policy, weeklyReview: event.target.checked })} /> Bilan hebdomadaire quand rien n’a été publié depuis sept jours</label>
          <p className="text-sm">Horaires privilégiés : calendrier de publication du ΞAgent (3 h–6 h par défaut), modifiable dans <a href="#xiagent-control" className="underline">Pilotage</a>{data.nextWindow && <> · prochaine fenêtre {date(data.nextWindow)}</>}. Aucun quota minimal : sans information vérifiée, rien n’est publié.</p>
        </fieldset>
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 font-medium">Format</legend>
          <p className="text-xs text-muted-foreground">Champ vide : limite globale du compte (Paramètres → Publications). Une publication trop longue n’est jamais tronquée : le modèle la reformule, sinon elle est mise en attente.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {NUMBERS.map(([key, label, min, max]) => <label key={key} className="grid gap-1 text-sm">{label}
              <Input type="number" min={min} max={max} value={overrides[key] === undefined ? "" : String(overrides[key])} placeholder={`Global : ${format.global.format[key]}`}
                onChange={event => setOverride(key, event.target.value === "" ? undefined : Number(event.target.value))} /></label>)}
            {SWITCHES.map(([key, label]) => <label key={key} className="grid gap-1 text-sm">{label}
              <select className={selectClass} value={overrides[key] === undefined ? "inherit" : overrides[key] ? "on" : "off"} onChange={event => setOverride(key, event.target.value === "inherit" ? undefined : event.target.value === "on")}>
                <option value="inherit">Global ({format.global.format[key] ? "activé" : "désactivé"})</option><option value="on">Activé</option><option value="off">Désactivé</option>
              </select></label>)}
          </div>
          <p className="text-sm">{format.resolved.ok ? <>Limites appliquées : {describeFormat(format.resolved.format)}</> : <strong className="text-destructive">Limites incohérentes, aucune rédaction possible : {format.resolved.problems.join(" ")}</strong>}</p>
        </fieldset>
        <Button type="submit" disabled={needsConfirmation && !confirmPublic}>Enregistrer les publications</Button>
      </fieldset>
    </form>

    <section aria-labelledby="draft-failures-title" className="space-y-2">
      <h4 id="draft-failures-title" className="text-sm font-semibold">Échecs de génération et refus de validation</h4>
      {!data.draftFailures.length && !failedDrafts.length ? <p className="text-sm text-muted-foreground">Aucun échec de rédaction.</p> :
        <ul className="divide-y rounded-lg border text-sm">
          {data.draftFailures.map(failure => <li key={failure.storyId} className="space-y-1 p-2">
            <p><span>{date(failure.at)}</span> · <span className="break-words font-medium">{failure.title}</span></p>
            {failure.reason && <p className="break-words text-destructive">{failure.reason}</p>}
            {failure.attempts.length > 0 && <details><summary className="cursor-pointer text-muted-foreground">{failure.attempts.length} essai(s)</summary>
              <ol className="mt-1 space-y-1 pl-5" style={{ listStyle: "decimal" }}>{failure.attempts.map((attempt, i) => <li key={i} className="break-words">{attempt.format === "thread" ? `thread de ${attempt.messages} messages` : "post"} : {attempt.problems.length ? attempt.problems.join(" ") : "conforme"}</li>)}</ol>
            </details>}
          </li>)}
          {failedDrafts.map((job, i) => <li key={`job-${i}`} className="p-2"><span>{date(job.runAfter)}</span> · Rédaction en échec ({job.attempts}/{job.maxAttempts} essais){job.lastError && <span className="block break-words text-destructive">{job.lastError}</span>}</li>)}
        </ul>}
    </section>

    <section aria-labelledby="decisions-title" className="space-y-2">
      <h4 id="decisions-title" className="text-sm font-semibold">Journal des décisions de publication</h4>
      {!data.decisions.length ? <p className="text-sm text-muted-foreground">Aucune décision de publication.</p> :
        <ul className="divide-y rounded-lg border text-sm">{data.decisions.map((decision, i) => <li key={i} className="flex flex-wrap gap-x-3 gap-y-1 p-2">
          <span>{date(decision.at)}</span><span className={decision.outcome === "published" ? "font-semibold" : decision.outcome === "abandoned" ? "text-destructive" : ""}>{DECISION[decision.outcome] ?? decision.outcome}{decision.visibility && decision.outcome === "published" ? ` (${decision.visibility === "public" ? "public" : "privé"})` : ""}</span>
          {decision.title && <span className="break-words font-medium">{decision.title}</span>}
          <span className="w-full break-words text-muted-foreground">{decision.reason}{decision.draftId && decision.outcome === "published" ? <> · <a className="underline" href={`/dashboard/publications/${decision.draftId}`}>voir la publication</a></> : null}</span>
        </li>)}</ul>}
    </section>
  </section>;
}
