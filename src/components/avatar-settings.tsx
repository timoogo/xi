"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserAvatar } from "./user-avatar";
import type { AvatarPreference } from "@/lib/avatar-preferences";
import { Button } from "./ui/button";

export function AvatarSettings({ name, avatar }: { name: string; avatar: AvatarPreference }) {
  const router = useRouter();
  const [saved, setSaved] = useState(avatar);
  const [seed, setSeed] = useState(avatar.seed);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  async function save() {
    setPending(true); setError(""); setStatus("");
    try {
      const response = await fetch("/api/account/avatar", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed, revision: saved.revision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Impossible d’enregistrer l’avatar.");
      setSaved(result.avatar); setSeed(result.avatar.seed);
      setStatus("Avatar enregistré."); router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible d’enregistrer l’avatar.");
    } finally { setPending(false); }
  }
  return <section aria-labelledby="avatar-title" className="space-y-4 border-b p-4">
    <h2 id="avatar-title" className="text-lg font-bold">Avatar</h2>
    <div aria-label="Aperçu de l’avatar"><UserAvatar name={name} bloubSeed={seed} size={88} /></div>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={() => { setSeed(crypto.randomUUID().replaceAll("-", "")); setStatus(""); }}>Régénérer</Button>
      <Button type="button" disabled={pending || seed === saved.seed} onClick={() => void save()}>Enregistrer</Button>
    </div>
    <p className="text-sm text-muted-foreground">Les variantes restent en aperçu jusqu’à l’enregistrement.</p>
    <p role="status" aria-live="polite" className="text-sm">{status}</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </section>;
}
