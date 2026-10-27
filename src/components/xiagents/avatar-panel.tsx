"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BloubEditor } from "@/components/bloub/bloub-editor";
import { ACTIVITY_LABELS } from "@/components/bloub/labels";
import { Button } from "@/components/ui/button";
import { sameBloubConfig } from "@/lib/bloub/config";
import type { AgentBloubSettings, XiAgentBloub } from "@/lib/xiagents/avatar";
import { UserAvatar } from "@/components/user-avatar";

/** Owner editor of a ΞAgent's Bloub. Testing states in the preview never touches the real activity. */
export function AvatarPanel({ agentId, name, initial, current }: { agentId: string; name: string; initial: AgentBloubSettings; current: XiAgentBloub }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial.config);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const dirty = !sameBloubConfig(draft, saved.config);
  async function save() {
    setPending(true); setStatus(""); setError("");
    try {
      const response = await fetch(`/api/xiagents/${agentId}/avatar`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: saved.revision, config: draft }),
      });
      const result = await response.json() as AgentBloubSettings & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Impossible d’enregistrer l’avatar.");
      setSaved(result); setDraft(result.config);
      setStatus("Avatar enregistré."); router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible d’enregistrer l’avatar.");
    } finally { setPending(false); }
  }
  return <section aria-labelledby="xiagent-avatar-title" className="space-y-4 border-b p-4">
    <div className="flex items-center gap-3">
      <UserAvatar name={name} bloub={{ ...current, config: saved.config }} size={48} />
      <p className="text-sm text-muted-foreground">État réel : {ACTIVITY_LABELS[current.activity]}. Les quatre états sont communs à tous les ΞAgents ; seules la forme et l’expression se personnalisent.</p>
    </div>
    <BloubEditor value={draft} onChange={value => { setDraft(value); setStatus(""); }} name={name} />
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={pending || !dirty} onClick={() => void save()}>{pending ? "Enregistrement…" : "Enregistrer l’avatar"}</Button>
      <Button type="button" variant="outline" disabled={pending || !dirty} onClick={() => setDraft(saved.config)}>Annuler les modifications</Button>
    </div>
    <p role="status" aria-live="polite" className="text-sm">{status}</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </section>;
}
