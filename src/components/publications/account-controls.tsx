"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Preference = "priority" | "normal" | "less" | "hidden";
export function AccountControls({ authorId, following, preference }: { authorId: string; following: boolean; preference?: Preference }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  function update(change: { following?: boolean; preference?: Preference | null }) {
    setError("");
    startTransition(async () => {
      try {
        const response = await fetch("/api/feed/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ authorId, ...change }) });
        if (!response.ok) throw new Error("Impossible d’enregistrer cette préférence. Réessayez.");
        router.refresh();
      } catch (failure) { setError(failure instanceof Error ? failure.message : "Le service est indisponible."); }
    });
  }
  return <div className="space-y-3 py-3">
    <button type="button" disabled={pending} aria-pressed={following} onClick={() => update({ following: !following })} className="rounded-full border px-4 py-2 font-semibold hover:bg-accent disabled:opacity-50">{following ? "Se désabonner" : "S’abonner"}</button>
    <label className="flex flex-wrap items-center gap-2 text-sm">Préférence éditoriale
      <select disabled={pending} value={preference ?? "inherit"} onChange={(event) => update({ preference: event.target.value === "inherit" ? null : event.target.value as Preference })} className="max-w-full rounded-md border bg-background p-2">
        <option value="inherit">Hériter du parent (sinon Normal)</option><option value="priority">Prioritaire</option><option value="normal">Normal</option><option value="less">Moins</option><option value="hidden">Masqué</option>
      </select>
    </label>
    <p className="text-xs text-muted-foreground">L’abonnement à un générateur inclut ses descendants. La préférence est indépendante de l’abonnement.</p>
    {pending ? <p role="status" className="text-sm">Enregistrement…</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </div>;
}
