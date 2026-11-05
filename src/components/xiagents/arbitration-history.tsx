import type { Arbitration, ArbitrationStatus } from "@/lib/arbiter/arbitration";

const STATUS_LABELS: Record<ArbitrationStatus, string> = {
  pending: "En attente de décision", favorable: "Prioritaire : oui", refused: "Prioritaire : non", unavailable: "Arbitre indisponible",
  disabled: "Arbitre désactivé", expired: "Délai dépassé", obsolete: "Actualité obsolète",
};
const OUTCOME_LABELS = { published: "Publiée", normal: "Renvoyée au circuit normal", abandoned: "Abandonnée par les contrôles de publication", skipped: "Non publiée" } as const;
const date = (value: string | number) => new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(value));

/** The viewer's own arbitration requests (never another user's): who asked, about what, the decision and why. */
export function ArbitrationHistory({ arbitrations }: { arbitrations: Arbitration[] }) {
  return <section aria-label="Historique des arbitrages" className="mt-4 border-t pt-3">
    <h4 className="text-sm font-bold">Historique des arbitrages</h4>
    {arbitrations.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">Aucune demande d’arbitrage de vos ΞAgents pour l’instant.</p> : null}
    <ol className="mt-2 space-y-3">{arbitrations.map(item => <li key={item.id} data-arbitration={item.status} className="rounded-lg bg-muted/50 p-3 text-sm">
      <p><span className="font-medium">{item.mention.from.handle}</span>{" · "}<span>« {item.title} »</span></p>
      <p className="mt-1 font-medium">{STATUS_LABELS[item.status]}</p>
      {item.decision ? <>
        <p className="mt-1"><span className="font-medium">Justification : </span>{item.decision.justification}</p>
        <ul aria-label="Critères déterminants" className="mt-1 flex flex-wrap gap-1.5">{item.decision.criteria.map(criterion => <li key={criterion} className="rounded-full bg-background px-2 py-0.5 text-xs">{criterion}</li>)}</ul>
        <p className="mt-1 text-xs text-muted-foreground">{`Modèle : ${item.decision.model} · prompt ${item.decision.promptVersion} · décidé le ${date(item.decision.decidedAt)}`}</p>
      </> : item.reason ? <p className="mt-1"><span className="font-medium">Raison : </span>{item.reason}</p> : null}
      {item.outcome ? <p className="mt-1"><span className="font-medium">{OUTCOME_LABELS[item.outcome.result]} : </span>{item.outcome.reason}</p> : null}
      <p className="mt-1 text-xs text-muted-foreground">{`Demandée le ${date(item.createdAt)}`}</p>
    </li>)}</ol>
  </section>;
}
