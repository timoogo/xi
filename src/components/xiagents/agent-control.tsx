"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Profile } from "@/lib/accounts/types";
import { scheduleSchema, type Pause, type ResolvedSchedule, type Schedule } from "@/lib/xiagents/schedule";
import { ScheduleForm } from "./schedule/schedule-form";

/**
 * Owner controls of a ΞAgent: mode (automatic / paused), pause with a recorded resume choice,
 * resume, one-off manual runs, calendars and editorial profile. Every action goes through the
 * server (authorisation, validation, history); the displayed state comes from the server.
 */
type Candidate = { storyId: string; title: string; status: string };
type Props = {
  agentId: string; enabled: boolean; paused: boolean; active: boolean; pause: Pause | null;
  schedule: ResolvedSchedule; profile: Profile | null; candidates: Candidate[];
  status: { watchOpen: boolean; publishOpen: boolean; nextWatch: string | null; nextPublish: string | null };
};
async function send<T>(url: string, method: string, data: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Action impossible.");
  return result as T;
}
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "aucune";
const strip = (schedule: ResolvedSchedule): Schedule => scheduleSchema.strip().parse(schedule);

export function AgentControl(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [until, setUntil] = useState("");
  const [resumeWith, setResumeWith] = useState<"now" | "catch-up">("now");
  const [story, setStory] = useState("");
  const [schedule, setSchedule] = useState<Schedule>(() => strip(props.schedule));
  const [revision, setRevision] = useState(props.schedule.revision);
  const [profile, setProfile] = useState<Profile>(props.profile ?? { perimeter: "", charter: "" });
  const dirty = JSON.stringify(schedule) !== JSON.stringify(strip(props.schedule)) || !props.schedule.explicit;
  async function act(task: () => Promise<string>) {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await task()); router.refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Action impossible."); }
    finally { setBusy(false); }
  }
  const control = (data: unknown) => send<{ runId: string; planned?: number; catchUp?: { reason: string } | null }>(`/api/xiagents/${props.agentId}/control`, "POST", data);
  const mode = !props.active ? "ΞAgent désactivé" : !props.enabled ? "Veille désactivée" : props.paused ? (props.pause?.resumeAt ? `En pause jusqu’au ${when(props.pause.resumeAt)}` : "En pause (durée indéterminée)") : "Automatique";
  const selected = props.candidates.find(item => item.storyId === story);

  return <section id="xiagent-control" aria-labelledby="xiagent-control-title" className="space-y-4 border-b p-4">
    <h2 id="xiagent-control-title" className="text-lg font-bold">Pilotage</h2>
    <div className="rounded-md border p-3 text-sm" aria-live="polite">
      <p><span className="font-medium">Mode :</span> {mode}</p>
      {props.paused && props.pause && <p className="text-muted-foreground">Depuis le {when(props.pause.since)} · reprise {props.pause.resumeWith === "catch-up" ? "avec rattrapage" : "à partir de ce moment"}{props.pause.resumeAt ? " (programmée)" : ""}.</p>}
      {!props.paused && props.enabled && <p className="text-muted-foreground">Veille {props.status.watchOpen ? "ouverte" : `fermée · prochaine ouverture : ${when(props.status.nextWatch)}`} · publication {props.status.publishOpen ? "ouverte" : `fermée · prochaine : ${when(props.status.nextPublish)}`}.</p>}
    </div>
    <p role="alert" className="text-sm text-destructive">{error}</p>
    <p role="status" className="text-sm">{notice}</p>

    {props.enabled && (props.paused
      ? <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void act(async () => { await control({ action: "resume", resumeWith: "now" }); return "Reprise à partir de maintenant."; })}>Reprendre maintenant</Button>
        <Button variant="outline" disabled={busy} onClick={() => void act(async () => { const result = await control({ action: "resume", resumeWith: "catch-up" }); return result.catchUp ? `Reprise avec rattrapage. ${result.catchUp.reason}` : "Reprise : aucune plage de veille manquée à rattraper."; })}>Reprendre avec rattrapage</Button>
      </div>
      : <form className="space-y-2 rounded-md border p-3" onSubmit={event => { event.preventDefault(); void act(async () => {
        const resumeAt = until ? new Date(until).toISOString() : null;
        await control({ action: "pause", resumeAt, resumeWith });
        return resumeAt ? `Pause jusqu’au ${when(resumeAt)}.` : "Pause indéfinie.";
      }); }}>
        <h3 className="font-medium">Mettre en pause</h3>
        <p className="text-xs text-muted-foreground">La pause arrête la veille, les publications et les exceptions pour événement majeur ; les tâches en cours sont suspendues proprement.</p>
        <label className="grid gap-1 text-sm">Reprise programmée (facultative, heure de votre navigateur)
          <input type="datetime-local" className="rounded-md border bg-background px-2 py-1.5" value={until} onChange={event => setUntil(event.target.value)} />
        </label>
        <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="text-sm">À la reprise</legend>
          <label className="flex items-center gap-1"><input type="radio" name="resume-with" checked={resumeWith === "now"} onChange={() => setResumeWith("now")} /> Repartir de ce moment</label>
          <label className="flex items-center gap-1"><input type="radio" name="resume-with" checked={resumeWith === "catch-up"} onChange={() => setResumeWith("catch-up")} /> Rattraper la veille manquée (dans la limite configurée)</label>
        </fieldset>
        <Button type="submit" variant="outline" disabled={busy}>Mettre en pause</Button>
      </form>)}

    {props.enabled && !props.paused && props.active && <div className="space-y-2 rounded-md border p-3">
      <h3 className="font-medium">Exécuter maintenant</h3>
      <p className="text-xs text-muted-foreground">Action ponctuelle : le mode automatique n’est pas modifié et rien n’est publié en dehors des règles. Les tâches sont exécutées au prochain passage du worker.</p>
      <Button size="sm" disabled={busy} onClick={() => void act(async () => { const result = await control({ action: "run", task: "watch" }); return result.planned ? `Veille lancée : ${result.planned} collecte(s) planifiée(s).` : "Aucune source approuvée : rien à collecter."; })}>Lancer une veille</Button>
      {props.candidates.length > 0 && <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 basis-56 grid-cols-[minmax(0,1fr)] gap-1 text-sm">Information analysée
          <select className="w-full min-w-0 truncate rounded-md border bg-background px-2 py-1.5 text-sm" value={story} onChange={event => setStory(event.target.value)}>
            <option value="">Choisir…</option>
            {props.candidates.map(item => <option key={item.storyId} value={item.storyId}>{item.title} ({item.status})</option>)}
          </select>
        </label>
        <Button size="sm" variant="outline" disabled={busy || !story} onClick={() => void act(async () => { await control({ action: "run", task: "reanalyze", storyId: story }); return "Analyse relancée."; })}>Relancer l’analyse</Button>
        <Button size="sm" variant="outline" disabled={busy || selected?.status !== "accepted"} onClick={() => void act(async () => { await control({ action: "run", task: "prepare", storyId: story }); return "Brouillon en préparation (relecture requise)."; })}>Préparer une publication</Button>
      </div>}
      {selected && selected.status !== "accepted" && <p className="text-xs text-muted-foreground">Seules les informations vérifiées et retenues peuvent préparer une publication.</p>}
    </div>}

    <details className="rounded-md border p-3">
      <summary className="cursor-pointer font-medium">Calendriers{props.schedule.explicit ? "" : " (calendrier hérité)"}</summary>
      <div className="mt-3 space-y-3">
        {!props.schedule.valid && <p className="text-sm text-destructive">Calendriers illisibles : la veille est fermée jusqu’à leur réenregistrement.</p>}
        {props.schedule.valid && !props.schedule.explicit && <p className="text-sm text-muted-foreground">Ce ΞAgent suit le fonctionnement antérieur (veille continue, publication de 3 h à 6 h). Enregistrez pour le rendre explicite et modifiable.</p>}
        <ScheduleForm value={schedule} onChange={setSchedule} disabled={busy} />
        <Button disabled={busy || !dirty} onClick={() => void act(async () => {
          const { schedule: saved } = await send<{ schedule: ResolvedSchedule }>(`/api/xiagents/${props.agentId}/schedule`, "PATCH", { revision, schedule });
          setRevision(saved.revision); setSchedule(strip(saved));
          return "Calendriers enregistrés.";
        })}>Enregistrer les calendriers</Button>
      </div>
    </details>

    <details className="rounded-md border p-3">
      <summary className="cursor-pointer font-medium">Périmètre et charte</summary>
      <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); void act(async () => { await send(`/api/xiagents/${props.agentId}/profile`, "PATCH", profile); return "Périmètre et charte enregistrés."; }); }}>
        <label className="grid gap-1 text-sm">Périmètre<Textarea rows={3} maxLength={4000} value={profile.perimeter} onChange={event => setProfile({ ...profile, perimeter: event.target.value })} /></label>
        <label className="grid gap-1 text-sm">Charte éditoriale propre<Textarea rows={3} maxLength={4000} value={profile.charter} onChange={event => setProfile({ ...profile, charter: event.target.value })} /></label>
        <Button type="submit" variant="outline" disabled={busy}>Enregistrer</Button>
      </form>
    </details>
  </section>;
}
