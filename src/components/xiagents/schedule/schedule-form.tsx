"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { isValidTimeZone } from "@/lib/xiagents/calendar";
import type { Schedule } from "@/lib/xiagents/schedule";
import { cn } from "@/lib/utils";
import { CalendarEditor } from "./calendar-editor";

/**
 * Calendars of a ΞAgent with their settings. Calendars are permissions, not obligations: outside
 * them the agent neither monitors nor publishes; inside them it works only when there is work.
 */
const TABS = [
  { key: "watch", label: "Veille", help: "Plages pendant lesquelles le ΞAgent peut surveiller ses sources, analyser et préparer des brouillons." },
  { key: "publish", label: "Publication", help: "Plages pendant lesquelles le ΞAgent peut publier ce qui a été validé (selon ses règles de publication)." },
] as const;

export const browserTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris"; } catch { return "Europe/Paris"; } };

export function ScheduleForm({ value, onChange, disabled = false }: { value: Schedule; onChange: (value: Schedule) => void; disabled?: boolean }) {
  const id = useId();
  const [tab, setTab] = useState<"watch" | "publish">("watch");
  const [zone, setZone] = useState(value.timeZone);
  const zones = useMemo(() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return [value.timeZone]; } }, [value.timeZone]);
  const zoneValid = isValidTimeZone(zone);
  const set = (patch: Partial<Schedule>) => onChange({ ...value, ...patch });
  const number = (raw: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(raw) || 0)));
  function keys(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = tab === "watch" ? "publish" : "watch";
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }
  const current = TABS.find(item => item.key === tab)!;
  return <fieldset disabled={disabled} className="space-y-4">
    <legend className="sr-only">Calendriers</legend>
    <label className="grid gap-1 text-sm">Fuseau horaire du ΞAgent
      <Input list={`${id}-zones`} value={zone} aria-invalid={!zoneValid} aria-describedby={`${id}-zone-help`}
        onChange={event => { setZone(event.target.value); if (isValidTimeZone(event.target.value)) set({ timeZone: event.target.value }); }} />
      <datalist id={`${id}-zones`}>{zones.map(item => <option key={item} value={item} />)}</datalist>
      <span id={`${id}-zone-help`} className={cn("text-xs", zoneValid ? "text-muted-foreground" : "text-destructive")}>
        {zoneValid ? "Les plages suivent l’heure locale de ce fuseau, changements d’heure compris : une heure inexistante (passage à l’heure d’été) est décalée d’une heure, une heure répétée (passage à l’heure d’hiver) prend la première occurrence." : "Fuseau IANA inconnu (exemple : Europe/Paris)."}
      </span>
    </label>

    <div role="tablist" aria-label="Calendrier à modifier" className="inline-flex rounded-md border p-0.5">
      {TABS.map(item => <button key={item.key} id={`${id}-tab-${item.key}`} type="button" role="tab" aria-selected={tab === item.key} aria-controls={`${id}-panel`} tabIndex={tab === item.key ? 0 : -1}
        onClick={() => setTab(item.key)} onKeyDown={keys}
        className={cn("rounded px-3 py-1.5 text-sm", tab === item.key ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>{item.label}</button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="space-y-2">
      <p className="text-sm text-muted-foreground">{current.help} Un calendrier ouvre une permission : le ΞAgent ne travaille que s’il a du travail.</p>
      <CalendarEditor key={tab} label={`Calendrier de ${current.label.toLowerCase()}`} calendar={value[tab]} timeZone={value.timeZone} onChange={calendar => set({ [tab]: calendar })} />
    </div>

    <details className="rounded-md border p-3">
      <summary className="cursor-pointer font-medium">Paramètres avancés</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">Tolérance en fin de plage (minutes)
          <Input type="number" min={0} max={240} value={value.graceMinutes} onChange={event => set({ graceMinutes: number(event.target.value, 0, 240) })} />
          <span className="text-xs text-muted-foreground">Une tâche en cours peut se terminer pendant ce délai ; au-delà, elle est interrompue proprement et reprise à la prochaine plage.</span>
        </label>
        <label className="grid gap-1 text-sm">Rattrapage maximal après interruption (heures)
          <Input type="number" min={0} max={168} value={value.catchUpHours} onChange={event => set({ catchUpHours: number(event.target.value, 0, 168) })} />
          <span className="text-xs text-muted-foreground">Après une panne du worker, seules les plages de veille manquées dans cette limite sont rattrapées (0 = aucun rattrapage).</span>
        </label>
        <label className="grid gap-1 text-sm">Conservation de l’historique d’exécution (jours)
          <Input type="number" min={1} max={365} placeholder="Réglage global (30 j par défaut)" value={value.retentionDays ?? ""} onChange={event => set({ retentionDays: event.target.value ? number(event.target.value, 1, 365) : null })} />
          <span className="text-xs text-muted-foreground">Vide = réglage global. Les publications, leurs sources et les décisions éditoriales sont toujours conservées.</span>
        </label>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="mt-1" checked={value.majorEvents.enabled} onChange={event => set({ majorEvents: { enabled: event.target.checked } })} />
          <span>Autoriser les exceptions pour événement majeur
            <span className="block text-xs text-muted-foreground">Hors calendrier, une détection légère peut traiter un événement très important, confirmé par plusieurs sources indépendantes, avec une limite de fréquence et une justification dans l’historique. Une pause explicite les bloque toujours.</span>
          </span>
        </label>
      </div>
    </details>
  </fieldset>;
}
