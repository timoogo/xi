import Link from "next/link";
import { correctTopicRelation, createTopicRelation, hideTopicRelation } from "@/lib/apis/topics";
import { topicHref } from "@/lib/search/query";
import { TOPIC_RELATION_TYPES, type RelationView, type TopicRelations, type TopicRelationType } from "@/lib/topics/relations";
import { RELATION_TYPE_LABELS } from "@/lib/topics/network";
import type { Topic } from "@/lib/topics/types";

const TYPES = RELATION_TYPE_LABELS;
const ACTIONS: Record<RelationView["history"][number]["action"], string> = {
  created: "créée", type_changed: "type corrigé", accepted: "validée", excluded: "exclue pour tous", restored: "rétablie", reproposed: "reproposée avec de nouvelles preuves",
};
export const RELATION_ERRORS: Record<string, string> = {
  "400": "Relation invalide : choisissez un topic et un type, avec une justification d’au moins 3 caractères.",
  "403": "Seul le créateur d’un des deux topics peut corriger ou exclure cette relation pour tous. Vous pouvez la masquer pour vous.",
  "404": "Relation ou topic introuvable.",
  "409": "Une relation identique existe déjà, ou une autre opération est en cours.",
  "422": "Justification ou preuves insuffisantes.",
};

const pct = (value: number) => `${Math.round(value * 100)} %`;
const EVIDENCE: Record<RelationView["evidence"][number]["kind"], string> = {
  publication: "Publication", source: "Source citée", claim: "Affirmation", cooccurrence: "Indice : cooccurrence", shared_word: "Indice : mot commun", shared_agent: "Indice : même ΞAgent",
};
const button = "rounded-full border px-3 py-1 text-xs font-medium hover:bg-accent";
const label = (view: RelationView) => view.type === "parent" ? "Hiérarchie" : view.direction === "incoming" ? TYPES[view.type].incoming : TYPES[view.type].outgoing;

function provenance(view: RelationView, viewer: string) {
  if (view.origin === "declared") return "Déclarée dans la fiche du topic par son créateur";
  if (view.origin === "agent") return "Proposée par un ΞAgent";
  if (view.origin === "inference") return "Inférence locale";
  return view.createdBy === viewer ? "Ajoutée par vous" : "Ajoutée par un membre";
}

function Hidden({ name, value }: { name: string; value: string }) { return <input type="hidden" name={name} value={value} />; }

function Relation({ view, topic, viewer, hidden = false }: { view: RelationView; topic: Topic; viewer: string; hidden?: boolean }) {
  const common = <><Hidden name="relationId" value={view.id} /><Hidden name="back" value={topic.tag} /></>;
  return (
    <li className="space-y-1 rounded-xl px-3 py-2" aria-label={`${label(view)} ${view.other.name}`}>
      <p>
        <span className="text-sm text-muted-foreground">{label(view)}</span>{" "}
        <Link href={topicHref(view.other.tag)} className="font-semibold hover:underline">{view.other.name}</Link>{" "}
        <span className="text-sm text-muted-foreground">#{view.other.tag}</span>
        {view.scope === "personal" ? <span className="ml-2 rounded-full border px-1.5 text-xs text-muted-foreground">personnelle</span> : null}
        {view.status === "proposed" ? <span className="ml-2 rounded-full border px-1.5 text-xs">proposée, non validée</span> : null}
        {view.status === "excluded" ? <span className="ml-2 rounded-full border px-1.5 text-xs">exclue pour tous</span> : null}
        {view.withheld ? <span className="ml-2 rounded-full border px-1.5 text-xs">preuves non accessibles</span> : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {provenance(view, viewer)}{view.confidence !== null ? ` · confiance ${Math.round(view.confidence * 100)} %` : ""}
      </p>
      {view.assessment ? <p className="text-xs text-muted-foreground">
        Évaluation séparée (la plus faible fixe la confiance) : sources {pct(view.assessment.sources)}, preuve {pct(view.assessment.evidence)}, inférence {pct(view.assessment.inference)}, cohérence du type {pct(view.assessment.type)}
      </p> : null}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Justification et historique</summary>
        <p className="mt-1 whitespace-pre-wrap break-words">{view.justification}</p>
        {view.evidence.length ? <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">{view.evidence.map((e, i) => e.withheld ? <li key={i}>{EVIDENCE[e.kind]} · preuve masquée (publication non accessible)</li> : <li key={i}>{EVIDENCE[e.kind]} · {e.ref.startsWith("publication:") ? <Link className="underline" href={`/dashboard/publications/${e.ref.slice(12)}`}>publication</Link> : /^https?:\/\//.test(e.ref) ? <a className="underline" href={e.ref} rel="noreferrer noopener" target="_blank">{e.ref}</a> : e.ref}{e.excerpt ? ` : « ${e.excerpt} »` : ""}</li>)}</ul> : null}
        {view.history.length ? <ol className="mt-1 text-xs text-muted-foreground">{view.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString("fr-FR")} : {ACTIONS[h.action]}{h.from && h.to ? ` (${TYPES[h.from as TopicRelationType]?.label ?? h.from} → ${TYPES[h.to as TopicRelationType]?.label ?? h.to})` : ""}{h.by === viewer ? " par vous" : ""}{h.reason ? `, motif : ${h.reason}` : ""}</li>)}</ol> : null}
      </details>
      <div className="flex flex-wrap items-center gap-2">
        {view.canHide && view.status === "accepted" ? <form action={hideTopicRelation}>{common}<Hidden name="hidden" value={hidden ? "0" : "1"} /><button className={button}>{hidden ? "Rétablir pour moi" : "Masquer pour moi"}</button></form> : null}
        {view.canManage && view.status === "proposed" ? <form action={correctTopicRelation}>{common}<Hidden name="status" value="accepted" /><button className={button}>Valider</button></form> : null}
        {view.canManage && view.status !== "excluded" ? <form action={correctTopicRelation}>{common}<Hidden name="status" value="excluded" /><button className={button}>Exclure pour tous</button></form> : null}
        {view.canManage && view.status === "excluded" ? <form action={correctTopicRelation}>{common}<Hidden name="status" value="accepted" /><button className={button}>Rétablir pour tous</button></form> : null}
        {view.canManage && view.type !== "parent" && view.status !== "excluded" ? (
          <form action={correctTopicRelation} className="flex flex-wrap items-center gap-1">
            {common}
            <label className="sr-only" htmlFor={`type-${view.id}`}>Type corrigé</label>
            <select id={`type-${view.id}`} name="type" defaultValue={view.type} className="rounded-md border bg-background px-1 py-0.5 text-xs">
              {TOPIC_RELATION_TYPES.map(type => <option key={type} value={type}>{TYPES[type].label}</option>)}
            </select>
            <label className="sr-only" htmlFor={`reason-${view.id}`}>Motif de la correction</label>
            <input id={`reason-${view.id}`} name="reason" maxLength={1000} placeholder="Motif" className="w-28 rounded-md border bg-background px-1 py-0.5 text-xs" />
            <button className={button}>Corriger le type</button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

/** Relations of one topic: established ones, then those the viewer hid, proposals and global exclusions. */
export function TopicRelationsSection({ topic, relations, candidates, viewer, error }: { topic: Topic; relations: TopicRelations; candidates: Topic[]; viewer: string; error?: string }) {
  const established = relations.visible.filter(view => view.kind !== "hierarchy");
  const hidden = relations.hidden.filter(view => view.kind !== "hierarchy");
  return (
    <section aria-labelledby="topic-related" className="border-b px-4 py-3">
      <h2 id="topic-related" className="mb-1 text-lg font-bold">Topics liés</h2>
      {error ? <p role="alert" className="mb-2 rounded-xl border border-destructive px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {established.length ? <ul>{established.map(view => <Relation key={view.id} view={view} topic={topic} viewer={viewer} />)}</ul>
        : <p className="px-3 text-sm text-muted-foreground">Aucune relation établie.</p>}
      {relations.proposed.length ? <><h3 className="mt-3 px-3 text-sm font-semibold">Propositions à valider</h3><ul>{relations.proposed.map(view => <Relation key={view.id} view={view} topic={topic} viewer={viewer} />)}</ul></> : null}
      {hidden.length ? <><h3 className="mt-3 px-3 text-sm font-semibold">Masquées pour vous</h3><ul>{hidden.map(view => <Relation key={view.id} view={view} topic={topic} viewer={viewer} hidden />)}</ul></> : null}
      {relations.excluded.length ? <><h3 className="mt-3 px-3 text-sm font-semibold">Exclues pour tous</h3><ul>{relations.excluded.map(view => <Relation key={view.id} view={view} topic={topic} viewer={viewer} />)}</ul></> : null}
      {candidates.length ? (
        <details className="mt-3 px-3">
          <summary className="cursor-pointer text-sm font-medium">Ajouter une relation</summary>
          <form action={createTopicRelation} className="mt-2 space-y-2 text-sm">
            <Hidden name="source" value={topic.id} /><Hidden name="back" value={topic.tag} />
            <label className="block">Type
              <select name="type" required className="mt-1 block w-full rounded-md border bg-background p-1.5">{TOPIC_RELATION_TYPES.map(type => <option key={type} value={type}>{topic.name} — {TYPES[type].outgoing.toLowerCase()} …</option>)}</select>
            </label>
            <label className="block">Topic
              <select name="target" required className="mt-1 block w-full rounded-md border bg-background p-1.5">{candidates.map(other => <option key={other.id} value={other.id}>{other.name} (#{other.tag})</option>)}</select>
            </label>
            <label className="block">Justification
              <textarea name="justification" required minLength={3} maxLength={2000} className="mt-1 block w-full rounded-md border bg-background p-1.5" />
            </label>
            <p className="text-xs text-muted-foreground">Partagée si vous avez créé l’un des deux topics communs ; sinon, enregistrée pour vous seul.</p>
            <button className={button}>Ajouter la relation</button>
          </form>
        </details>
      ) : null}
    </section>
  );
}
