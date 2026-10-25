"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import type { ModelInfo } from "@/lib/llm/types";
import { formatBytes, selectClass } from "./format";

const OTHER = "\u0000other";

/**
 * Model choice among the discovered models; free entry while none were discovered (or for a
 * model installed since the last refresh). A value absent from the list is shown as such, never
 * replaced. `empty`: label of the empty choice (inherit), omitted when a model is required.
 */
export function ModelPicker({ id, models, value, onChange, empty, disabled, describedBy }: {
  id: string; models: ModelInfo[] | null; value: string; onChange: (value: string) => void; empty?: string; disabled?: boolean; describedBy?: string;
}) {
  const known = models ?? [];
  const listed = known.some(model => model.name === value);
  const [free, setFree] = useState(!models?.length || (!!value && !listed));
  if (free || !known.length) {
    return <div className="flex gap-2">
      <Input id={id} value={value} maxLength={200} disabled={disabled} placeholder={empty ? `vide : ${empty}` : "ex. qwen3:1.7b"} aria-describedby={describedBy} onChange={event => onChange(event.target.value)} />
      {known.length > 0 && <button type="button" className="shrink-0 rounded text-xs underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={() => { setFree(false); if (!listed) onChange(""); }}>Choisir dans la liste</button>}
    </div>;
  }
  return <select id={id} className={selectClass} value={value} disabled={disabled} aria-describedby={describedBy}
    onChange={event => { if (event.target.value === OTHER) setFree(true); else onChange(event.target.value); }}>
    {empty !== undefined ? <option value="">{empty}</option> : !value && <option value="" disabled>Choisissez un modèle</option>}
    {known.map(model => <option key={model.name} value={model.name}>{model.name}{model.parameterSize ? ` · ${model.parameterSize}` : ""}{model.sizeBytes !== null ? ` · ${formatBytes(model.sizeBytes)}` : ""}</option>)}
    <option value={OTHER}>Autre modèle (saisie libre)…</option>
  </select>;
}
