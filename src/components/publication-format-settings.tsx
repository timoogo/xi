"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormatSettings } from "@/lib/watch/format";
import type { OwnerFormat } from "@/lib/watch/format-store";

const NUMBERS: [keyof FormatSettings, string, number, number][] = [
  ["maxPostChars", "Longueur maximale d’un post (caractères)", 50, 5_000],
  ["maxThreadMessageChars", "Longueur maximale d’un message de thread (caractères)", 50, 5_000],
  ["minThreadMessages", "Messages par thread : minimum", 2, 10],
  ["maxThreadMessages", "Messages par thread : maximum", 2, 10],
  ["targetPostMin", "Longueur cible d’un post : de", 50, 5_000],
  ["targetPostMax", "Longueur cible d’un post : à", 50, 5_000],
  ["correctionAttempts", "Tentatives de correction du format", 0, 5],
];

/** Settings → Publications: the account's global limits, which each ΞAgent may override. */
export function PublicationFormatSettings({ initial }: { initial: OwnerFormat }) {
  const [data, setData] = useState(initial);
  const [format, setFormat] = useState(initial.format);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function save() {
    setBusy(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/publishing/format", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: data.revision, format }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Enregistrement impossible. Réessayez.");
      setData(result); setFormat(result.format); setNotice("Limites de publication enregistrées.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Enregistrement impossible."); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="publication-format-title" className="space-y-3 border-b p-4">
    <h2 id="publication-format-title" className="text-lg font-bold">Publications</h2>
    <p className="text-sm text-muted-foreground">Limites appliquées à chaque publication de vos ΞAgents, sauf surcharge dans leur section « Publications ». Chaque message d’un thread est contrôlé individuellement ; un texte trop long n’est jamais tronqué : le modèle le reformule, sinon la rédaction échoue explicitement.</p>
    {!data.valid && <p role="alert" className="text-sm text-destructive">Limites enregistrées illisibles : les valeurs par défaut s’appliquent jusqu’au prochain enregistrement.</p>}
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {NUMBERS.map(([key, label, min, max]) => <label key={key} className="grid gap-1 text-sm">{label}
            <Input type="number" min={min} max={max} required value={String(format[key])} onChange={event => setFormat({ ...format, [key]: Number(event.target.value) })} /></label>)}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={format.threads} onChange={event => setFormat({ ...format, threads: event.target.checked })} /> Génération de threads</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={format.autoFormat} onChange={event => setFormat({ ...format, autoFormat: event.target.checked })} /> Choix automatique post / thread</label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Enregistrer les limites</Button>
          <Button type="button" variant="outline" onClick={() => setFormat(data.defaults)}>Valeurs par défaut</Button>
        </div>
      </fieldset>
    </form>
    <div aria-live="polite">{notice && <p role="status" className="text-sm">{notice}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
  </section>;
}
