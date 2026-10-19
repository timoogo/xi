import type { PublicationMeta, Visibility } from "@/lib/publications/types";

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: "Moi uniquement",
  followers: "Abonnés",
  public: "Public",
};

const badge = "rounded-full border px-2 py-0.5 text-xs font-medium";

export function PublicationBadges({ status, visibility, type }: Pick<PublicationMeta, "status" | "visibility" | "type">) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {status === "draft" ? <span className={`${badge} border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300`}>Brouillon</span> : null}
      <span className={badge}>{type === "thread" ? "Fil" : "Post"}</span>
      <span className={`${badge} text-muted-foreground`}>{VISIBILITY_LABELS[visibility]}</span>
    </span>
  );
}

// Dates are shown in UTC so that server rendering never depends on the host time zone.
const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const dayFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const yearFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${dateFormat.format(date)} UTC`;
};

/** Compact feed date: "à l’instant", "12 min", "3 h", then "19 oct." or "19 oct. 2025". */
export function formatShortDate(value: string, now = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes >= 0 && minutes < 1) return "à l’instant";
  if (minutes >= 0 && minutes < 60) return `${minutes} min`;
  if (minutes >= 0 && minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  return (date.getUTCFullYear() === new Date(now).getUTCFullYear() ? dayFormat : yearFormat).format(date);
}
