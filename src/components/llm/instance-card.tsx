import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { LLMInstance, ModelInfo } from "@/lib/llm/types";
import { DASH, date, formatBytes, providerLabel, statusText } from "./format";

/** Discovered models: absent metadata stays "—", never guessed. */
export function ModelTable({ models, caption }: { models: ModelInfo[]; caption: string }) {
  if (!models.length) return <p className="text-sm text-muted-foreground">Aucun modèle installé sur ce serveur. Installez-en un avec Ollama (aucun téléchargement n’est lancé depuis Ξ).</p>;
  const cell = (value: string | number | null) => value === null || value === "" ? DASH : String(value);
  return <div className="overflow-x-auto">
    <table className="w-full min-w-[36rem] text-left text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead><tr className="border-b">
        {["Nom", "Taille", "Famille", "Paramètres", "Quantification", "Contexte"].map(label => <th key={label} scope="col" className="px-2 py-1 font-medium">{label}</th>)}
      </tr></thead>
      <tbody>{models.map(model => <tr key={model.name} className="border-b last:border-0">
        <th scope="row" className="break-all px-2 py-1 font-medium">{model.name}</th>
        <td className="px-2 py-1">{formatBytes(model.sizeBytes)}</td>
        <td className="px-2 py-1">{cell(model.family)}</td>
        <td className="px-2 py-1">{cell(model.parameterSize)}</td>
        <td className="px-2 py-1">{cell(model.quantization)}</td>
        <td className="px-2 py-1">{model.contextLength === null ? DASH : `${model.contextLength.toLocaleString("fr-FR")} tokens`}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export type InstanceAction = "check" | "edit" | "toggle" | "delete" | "default";

/** One configured instance: identity, state in words (colour only repeats it), models and actions. */
export function InstanceCard({ instance, isDefault, busy, onAction, children }: {
  instance: LLMInstance; isDefault: boolean; busy: boolean; onAction: (action: InstanceAction) => void; children?: ReactNode;
}) {
  const headingId = `llm-instance-${instance.id}`;
  const failing = instance.status.state === "error";
  return <article aria-labelledby={headingId} className="space-y-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-baseline gap-2">
      <h3 id={headingId} className="break-words font-semibold">{instance.name}</h3>
      <span className="text-xs text-muted-foreground">{providerLabel(instance.type)} · clé « {instance.key} »</span>
      {isDefault && <span className="rounded-full border px-2 text-xs font-medium">Par défaut</span>}
      <span className="rounded-full border px-2 text-xs">{instance.enabled ? "Activée" : "Désactivée"}</span>
    </div>
    <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      <dt className="text-muted-foreground">URL</dt><dd className="break-all font-mono text-xs leading-5">{instance.baseUrl}</dd>
      <dt className="text-muted-foreground">Modèle par défaut</dt><dd className="break-all">{instance.defaultModel ?? "aucun (chaque ΞAgent doit en choisir un)"}</dd>
      <dt className="text-muted-foreground">Connexion</dt>
      <dd className={failing ? "text-destructive" : ""}>{failing && <span aria-hidden="true">⚠ </span>}{statusText(instance.status)}</dd>
      <dt className="text-muted-foreground">Modèles</dt>
      <dd>{instance.models === null ? "Pas encore découverts : actualisez la liste." : `${instance.models.length} installé(s), liste du ${date(instance.modelsAt)}`}</dd>
    </dl>
    {instance.models !== null && instance.models.length > 0 && <details className="text-sm">
      <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Voir les modèles installés</summary>
      <div className="mt-2"><ModelTable models={instance.models} caption={`Modèles installés sur ${instance.name}`} /></div>
    </details>}
    {instance.models !== null && instance.models.length === 0 && <ModelTable models={[]} caption="" />}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onAction("check")}>Tester la connexion</Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onAction("check")} aria-label={`Actualiser les modèles de ${instance.name}`}>Actualiser les modèles</Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onAction("edit")}>Modifier</Button>
      {!isDefault && instance.enabled && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onAction("default")}>Utiliser par défaut</Button>}
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onAction("toggle")}>{instance.enabled ? "Désactiver" : "Réactiver"}</Button>
      <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => onAction("delete")}>Supprimer</Button>
    </div>
    {children}
  </article>;
}
