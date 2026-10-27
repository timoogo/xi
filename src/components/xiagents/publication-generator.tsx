"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { resolutionText } from "@/components/llm/format";
import type { Resolution } from "@/lib/llm/types";
import type { WatchDiagnostics } from "@/lib/watch/diagnostics";
import { DraftCard } from "./watch-drafts";

type Candidate = { storyId: string; title: string | null; importance: number | null };

/**
 * Real publication: verified information → the agent's model → checks → private draft, shown here
 * for review; publishing it is the draft's own confirmed action (private). No fixture fallback:
 * an error is the server's real message. No simulated progress: the request lasts as long as the model.
 */
export function PublicationGenerator({ agentId, candidates, drafts, llm }: { agentId: string; candidates: Candidate[]; drafts: WatchDiagnostics["drafts"]; llm: Resolution }) {
  const router = useRouter();
  const [format, setFormat] = useState<"post" | "thread">("post");
  const [storyId, setStoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const draft = draftId ? drafts.find(item => item.id === draftId) ?? null : null;

  async function generate() {
    setBusy(true); setError(""); setNotice(""); setDraftId(null);
    try {
      const response = await fetch(`/api/xiagents/${agentId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format, ...(storyId ? { storyId } : {}) }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `Génération impossible (HTTP ${response.status}).`);
      setDraftId(result.draft.id);
      setNotice(`Brouillon privé rédigé par ${result.llm.model} (${result.llm.instance}). Relisez-le, puis confirmez ou rejetez.`);
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Génération impossible."); }
    finally { setBusy(false); }
  }
  async function act(task: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try { await task(); setNotice(success); router.refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Opération impossible."); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="publication-generator" className="space-y-4 border-b p-4">
    <h3 id="publication-generator" className="text-lg font-bold">Générer une publication</h3>
    <p className="text-sm text-muted-foreground">Rédaction réelle à partir des informations collectées et vérifiées par la veille : le modèle de ce ΞAgent rédige uniquement à partir des affirmations vérifiées, Ξ contrôle chaque chiffre, citation et attribution, puis enregistre un brouillon privé. Rien n’est publié sans votre confirmation.</p>
    <p className="text-sm">Modèle : {llm.ok ? <strong>{resolutionText(llm)}</strong> : <strong className="text-destructive"><span aria-hidden="true">⚠ </span>{resolutionText(llm)}</strong>}</p>
    {!candidates.length ? <p className="text-sm">Aucune information vérifiée et retenue à rédiger pour l’instant. Lancez une veille (collecte puis analyse) depuis le pilotage du ΞAgent.</p>
      : <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1">Format<select className="rounded-md border bg-background p-2" value={format} onChange={event => setFormat(event.target.value as "post" | "thread")}><option value="post">Post simple</option><option value="thread">Thread</option></select></label>
        <label className="grid min-w-0 gap-1">Information vérifiée<select className="max-w-full rounded-md border bg-background p-2" value={storyId} onChange={event => setStoryId(event.target.value)}>
          <option value="">La plus importante</option>
          {candidates.map(candidate => <option key={candidate.storyId} value={candidate.storyId}>{candidate.title ?? "Actualité"}{candidate.importance !== null ? ` · importance ${candidate.importance.toFixed(2)}` : ""}</option>)}
        </select></label>
        <Button type="button" disabled={!llm.ok} onClick={() => void generate()}>{format === "thread" ? "Générer un thread" : "Générer un post"}</Button>
      </fieldset>}
    <div aria-live="polite">
      {busy && !draftId && <p role="status" className="text-sm">Rédaction en cours par le modèle local, vérifications comprises. Sur une petite machine, cela peut prendre plusieurs minutes.</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    {draft && <div aria-label="Aperçu avant publication"><ul><DraftCard agentId={agentId} draft={draft} busy={busy} act={act} /></ul></div>}
  </section>;
}
