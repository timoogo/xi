"use client";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { BUILTIN_INFERENCE_OPTIONS, type InferenceOptions, type ResolvedInferenceOptions } from "@/lib/llm/types";

type Key = keyof InferenceOptions;
/** Timeout is edited in seconds, stored in milliseconds. */
const FIELDS: { key: Key; label: string; hint: string; min: number; max: number; step: number; scale: number }[] = [
  { key: "temperature", label: "Température", hint: "0 = réponses déterministes, adapté à une veille factuelle.", min: 0, max: 2, step: 0.1, scale: 1 },
  { key: "maxTokens", label: "Limite de génération (tokens)", hint: "Longueur maximale d’une réponse.", min: 16, max: 32_768, step: 1, scale: 1 },
  { key: "timeoutMs", label: "Délai maximal (secondes)", hint: "Au-delà, la requête échoue et la tâche est reprogrammée.", min: 5, max: 600, step: 1, scale: 1_000 },
  { key: "contextSize", label: "Taille de contexte (tokens)", hint: "Vide : celle du modèle. Une valeur élevée demande plus de mémoire.", min: 512, max: 262_144, step: 1, scale: 1 },
];

/**
 * Advanced inference parameters, folded by default. An empty field inherits: its placeholder
 * shows the inherited value (`inherited`), so nothing is hidden and nothing is forced.
 */
export function OptionsFields({ value, onChange, inherited = BUILTIN_INFERENCE_OPTIONS, inheritedFrom = "valeurs par défaut", disabled }: {
  value: InferenceOptions; onChange: (value: InferenceOptions) => void; inherited?: ResolvedInferenceOptions; inheritedFrom?: string; disabled?: boolean;
}) {
  const base = useId();
  const overridden = Object.values(value).filter(item => item !== undefined).length;
  function set(key: Key, raw: string, scale: number) {
    const next = { ...value };
    if (raw.trim() === "") delete next[key];
    else {
      const number = Number(raw) * scale;
      if (!Number.isFinite(number)) return;
      next[key] = key === "temperature" ? number : Math.round(number);
    }
    onChange(next);
  }
  return <details className="rounded-md border p-2 text-sm">
    <summary className="cursor-pointer rounded font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Réglages avancés d’inférence {overridden ? `(${overridden} personnalisé${overridden > 1 ? "s" : ""})` : "(hérités)"}</summary>
    <p className="mt-2 text-xs text-muted-foreground">Laissez un champ vide pour hériter ({inheritedFrom}).</p>
    <div className="mt-2 grid gap-3 sm:grid-cols-2">
      {FIELDS.map(field => {
        const id = `${base}-${field.key}`;
        const current = value[field.key];
        const fallback = inherited[field.key];
        return <div key={field.key} className="grid gap-1">
          <label htmlFor={id} className="text-xs font-medium">{field.label}</label>
          <Input id={id} type="number" inputMode="decimal" min={field.min} max={field.max} step={field.step} disabled={disabled}
            value={current === undefined ? "" : String(current / field.scale)}
            placeholder={fallback === null ? "modèle" : `hérité : ${fallback / field.scale}`}
            aria-describedby={`${id}-hint`} onChange={event => set(field.key, event.target.value, field.scale)} />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">{field.hint}</p>
        </div>;
      })}
    </div>
  </details>;
}
