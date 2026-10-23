"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UserAvatar } from "./user-avatar";
import type { AvatarPreference } from "@/lib/avatar-preferences";
import { Button } from "./ui/button";

export function AvatarSettings({ name, image, avatar }: { name: string; image?: string | null; avatar: AvatarPreference }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(image);
  const [saved, setSaved] = useState(avatar);
  const [draft, setDraft] = useState(avatar);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  async function update(file: File | null) {
    setError(""); setStatus("");
    if (file && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Choisissez une image JPEG, PNG ou WebP."); return;
    }
    if (file && file.size > 5 * 1024 * 1024) {
      setError("L’image dépasse la limite de 5 Mo."); return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/account/avatar", {
        method: file ? "PUT" : "DELETE",
        ...(file ? { headers: { "Content-Type": file.type }, body: file } : {}),
      });
      const result = await response.json() as { image?: string | null; avatar: AvatarPreference; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Impossible de mettre à jour la photo.");
      setCurrent(result.image);
      setSaved(result.avatar); setDraft(result.avatar);
      setStatus(file ? "Photo de profil enregistrée." : "Photo de profil supprimée.");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de mettre à jour la photo.");
    } finally { setPending(false); }
  }
  async function save() {
    setPending(true); setError(""); setStatus("");
    try {
      const response = await fetch("/api/account/avatar", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, revision: saved.revision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Impossible d’enregistrer l’avatar.");
      setSaved(result.avatar); setDraft(result.avatar);
      setStatus("Avatar enregistré."); router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible d’enregistrer l’avatar.");
    } finally { setPending(false); }
  }
  return <section aria-labelledby="avatar-title" className="space-y-4 border-b p-4">
    <div><h2 id="avatar-title" className="text-lg font-bold">Avatar</h2>
      <p id="avatar-help" className="mt-1 text-sm text-muted-foreground">JPEG, PNG ou WebP non animé · 5 Mo maximum · 16 mégapixels maximum. La photo est centrée dans un carré et visible par les autres utilisateurs de Ξ.</p></div>
    <div aria-label="Aperçu de l’avatar"><UserAvatar name={name} image={draft.mode === "photo" ? current : null} bloubSeed={draft.mode === "bloub" ? draft.seed : null} size={88} /></div>
    <div className="flex flex-wrap gap-2" aria-label="Type d’avatar">
      <Button type="button" variant="outline" aria-pressed={draft.mode === "bloub"} disabled={pending} onClick={() => setDraft({ ...draft, mode: "bloub" })}>Mon Bloub</Button>
      <Button type="button" variant="outline" aria-pressed={draft.mode === "photo"} disabled={pending || !current} onClick={() => setDraft({ ...draft, mode: "photo" })}>Ma photo</Button>
      <Button type="button" variant="outline" disabled={pending} onClick={() => { setDraft({ ...draft, seed: crypto.randomUUID().replaceAll("-", ""), mode: "bloub" }); setStatus(""); }}>Régénérer</Button>
      <Button type="button" disabled={pending || (draft.seed === saved.seed && draft.mode === saved.mode)} onClick={() => void save()}>Enregistrer</Button>
    </div>
    <p className="text-sm text-muted-foreground">Les variantes restent en aperçu jusqu’à l’enregistrement. Votre photo est conservée lorsque vous choisissez Bloub.</p>
    <div className="flex flex-wrap gap-2">
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choisir une photo de profil" aria-describedby="avatar-help" disabled={pending} className="sr-only" tabIndex={-1} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void update(file);
      }} />
      <Button type="button" disabled={pending} onClick={() => input.current?.click()}>{pending ? "Enregistrement…" : current ? "Modifier la photo" : "Importer une photo"}</Button>
      {current ? <Button type="button" variant="outline" disabled={pending} onClick={() => void update(null)}>Supprimer la photo</Button> : null}
    </div>
    <p role="status" aria-live="polite" className="text-sm">{status}</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </section>;
}
