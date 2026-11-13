import { Ban, CheckCircle2, CircleDashed, Clock, Loader2, MinusCircle, PauseCircle, TriangleAlert, XCircle, type LucideIcon } from "lucide-react";
import type { PipelineJobStatus, PipelineStatus } from "@/lib/konstruktor/pipelines";

type Status = PipelineStatus | PipelineJobStatus;
const STATUS: Record<Status, { label: string; icon: LucideIcon; tone: string }> = {
  queued: { label: "En file", icon: Clock, tone: "text-muted-foreground" },
  running: { label: "En cours", icon: Loader2, tone: "text-sky-700 dark:text-sky-400" },
  interrupted: { label: "Interrompu", icon: PauseCircle, tone: "text-amber-700 dark:text-amber-400" },
  success: { label: "Réussi", icon: CheckCircle2, tone: "text-emerald-700 dark:text-emerald-400" },
  partial: { label: "Partiel", icon: TriangleAlert, tone: "text-amber-700 dark:text-amber-400" },
  failed: { label: "Échoué", icon: XCircle, tone: "text-destructive" },
  skipped: { label: "Ignoré", icon: MinusCircle, tone: "text-muted-foreground" },
  cancelled: { label: "Annulé", icon: Ban, tone: "text-muted-foreground" },
};
export const statusLabel = (status: Status) => STATUS[status].label;

/** Icon and label together: the colour is never the only signal. */
export function StatusBadge({ status, compact = false }: { status: Status; compact?: boolean }) {
  const { label, icon: Icon, tone } = STATUS[status] ?? { label: status, icon: CircleDashed, tone: "" };
  return <span data-status={status} className={`inline-flex shrink-0 items-center gap-1 font-medium ${tone}`}>
    <Icon aria-hidden className={`size-4 ${status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`} />
    <span className={compact ? "sr-only" : ""}>{label}</span>
  </span>;
}

export function duration(ms: number | null) {
  if (ms === null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
export const dateTime = (ms: number | null) => ms === null ? "—" : new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Paris" });

export function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total ? Math.round((done / total) * 100) : 100;
  return <div className="flex min-w-0 items-center gap-2">
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1.5 w-full min-w-16 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
    </div>
    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{done}/{total}</span>
  </div>;
}
