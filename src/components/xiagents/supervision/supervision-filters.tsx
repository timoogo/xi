"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ACTIVITY_STATE_LABELS, ACTIVITY_STATES, QUEUE_STATE_LABELS, QUEUE_STATES, supervisionHref, type SupervisionParams, type SupervisionView } from "@/lib/xiagents/supervision-shared";

const ALL = "all";
type Option = { value: string; label: string };

function FilterSelect({ label, value, options, onChange }: { label: string; value: string | undefined; options: Option[]; onChange: (value: string | undefined) => void }) {
  const items = [{ value: ALL, label: "Tous" }, ...options];
  return <div className="grid gap-1">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <Select items={items} value={value ?? ALL} onValueChange={next => onChange(!next || next === ALL ? undefined : String(next))}>
      <SelectTrigger size="sm" aria-label={label} className="min-w-40"><SelectValue /></SelectTrigger>
      <SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}

/**
 * Filters live in the URL: the page is rendered on the server from them, survives reloads and
 * history, and never polls. Read-only: nothing here changes an agent or a publication.
 */
export function SupervisionFilters({ view, params, agents, topics, period }: {
  view: SupervisionView; params: SupervisionParams; agents: Option[]; topics: Option[]; period?: { from: string; to: string };
}) {
  const router = useRouter();
  const go = (changes: SupervisionParams) => router.push(supervisionHref(params, changes));
  const states = view === "queue" ? QUEUE_STATES.map(value => ({ value, label: QUEUE_STATE_LABELS[value] })) : view === "activity" ? ACTIVITY_STATES.map(value => ({ value, label: ACTIVITY_STATE_LABELS[value] })) : null;
  return <form role="search" aria-label="Filtres de supervision" className="flex flex-wrap items-end gap-3" onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    go({ from: String(data.get("from") ?? "") || undefined, to: String(data.get("to") ?? "") || undefined });
  }}>
    <FilterSelect label="ΞAgent" value={params.agent} options={agents} onChange={agent => go({ agent })} />
    <FilterSelect label="Topic" value={params.topic} options={topics} onChange={topic => go({ topic })} />
    {states && <FilterSelect label="État" value={params.state} options={states} onChange={state => go({ state })} />}
    {period && <>
      <div className="grid gap-1"><Label htmlFor="supervision-from" className="text-xs text-muted-foreground">Du</Label><Input id="supervision-from" name="from" type="date" defaultValue={period.from} className="h-8 w-40" /></div>
      <div className="grid gap-1"><Label htmlFor="supervision-to" className="text-xs text-muted-foreground">Au</Label><Input id="supervision-to" name="to" type="date" defaultValue={period.to} className="h-8 w-40" /></div>
      <Button type="submit" size="sm" variant="outline">Appliquer la période</Button>
    </>}
    {(params.agent || params.topic || params.state || params.story || params.from || params.to) && <Button type="button" size="sm" variant="ghost" onClick={() => go({ agent: undefined, topic: undefined, state: undefined, story: undefined, from: undefined, to: undefined })}>Effacer les filtres</Button>}
  </form>;
}
