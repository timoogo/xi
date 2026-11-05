import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { KonstruktorPanel } from "@/components/konstruktor/konstruktor-panel";
import { PageHeader } from "@/components/page-header";
import { PublicationFeed } from "@/components/publications/publication-feed";
import { AgentItem, ResultSection, TopicItem } from "@/components/search/result-items";
import { toggleTopicKnowledge, toggleTopicSubscription } from "@/lib/apis/topics";
import { getCurrentUser } from "@/lib/current-user";
import { getPublicationStore } from "@/lib/publications/server";
import { getDiscoveryRecords, getTopicRelationStore } from "@/lib/topics/server";
import { networkHref } from "@/lib/topics/network";
import { isPersonal } from "@/lib/topics/types";
import { RELATION_ERRORS, TopicRelationsSection } from "@/components/topics/topic-relations";
import { normalizeTag, searchHref, topicHref } from "@/lib/search/query";
import { resolveTopic, topicAgents } from "@/lib/search/resolve";
import { searchData } from "@/lib/search/server";

export const metadata: Metadata = { title: "Ξ | Topic" };
const VIA = { hashtag: "hashtag", tag: "tag", alias: "ancien tag", name: "nom du topic", model: "modèle" } as const;

/** Permanent, read-only page of a topic, addressed by its current tag; former tags redirect to it. */
export default async function TopicPage({ params, searchParams }: { params: Promise<{ tag: string }>; searchParams: Promise<{ cursor?: string; relation?: string }> }) {
  const [{ tag: raw }, { cursor, relation: relationError }, viewer] = await Promise.all([params, searchParams, getCurrentUser()]);
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { notFound(); }
  const tag = normalizeTag(decoded);
  if (!tag) notFound();
  const [{ topics, agents }, settings] = await Promise.all([searchData(viewer.id), getPublicationStore().then(store => store.social(viewer))]);
  const match = resolveTopic(topics, tag);
  // Unknown tag: the search page explains it and suggests close topics.
  if (!match) redirect(searchHref(`#${tag}`));
  const topic = match.topic;
  if (topic.tag !== decoded) redirect(topicHref(topic.tag));

  const parent = topics.find(t => t.id === topic.parentId);
  const children = topics.filter(t => t.parentId === topic.id);
  const [relations, inferred] = await Promise.all([
    getTopicRelationStore().then(store => store.relationsOf(viewer.id, topic.id)),
    // Discovery only reads public publications and the shared catalogue: never anything for a personal topic.
    isPersonal(topic) ? [] : getDiscoveryRecords().then(store => store.associationsOf(topic.id)),
  ]);
  const experts = topicAgents(topic.id, agents);
  const personal = isPersonal(topic);
  const subscribed = settings.topics.includes(topic.id);
  const known = settings.knowledge.includes(topic.id);
  // A shared topic created after this personal one with the same tag: the owner keeps their own, both stay distinct.
  const sharedTwin = personal ? topics.find(t => !isPersonal(t) && (t.tag === topic.tag || t.aliases.includes(topic.tag))) : undefined;

  return <>
    <PageHeader title={topic.name} subtitle={`#${topic.tag}`} back={{ href: "/dashboard/explore", label: "Retour à l’exploration" }}>
      <form action={toggleTopicSubscription}>
        <input type="hidden" name="topicId" value={topic.id} />
        <input type="hidden" name="subscribe" value={subscribed ? "0" : "1"} />
        <button type="submit" aria-pressed={subscribed} title={subscribed ? "Se désabonner" : undefined}
          className={subscribed ? "rounded-full border px-4 py-1.5 text-sm font-bold hover:border-destructive hover:text-destructive" : "rounded-full bg-foreground px-4 py-1.5 text-sm font-bold text-background hover:opacity-90"}>
          {subscribed ? "Abonné" : "S’abonner"}
        </button>
      </form>
      <form action={toggleTopicKnowledge}>
        <input type="hidden" name="topicId" value={topic.id} />
        <input type="hidden" name="known" value={known ? "0" : "1"} />
        <button type="submit" aria-pressed={known} title={known ? "Retirer de mes connaissances" : undefined}
          className="rounded-full border px-4 py-1.5 text-sm font-bold hover:bg-accent aria-pressed:border-chart-2 aria-pressed:text-chart-2">
          {known ? "Connaissance acquise" : "Je connais ce sujet"}
        </button>
      </form>
    </PageHeader>
    <section aria-label="Présentation du topic" className="space-y-3 border-b p-4">
      {personal ? <p className="rounded-xl border bg-muted/50 px-3 py-2 text-sm">
        <strong>Topic personnel</strong> : visible uniquement par vous. Il ne réserve pas ce tag dans le catalogue commun.
      </p> : null}
      {sharedTwin ? <p className="rounded-xl border px-3 py-2 text-sm">
        Un topic commun porte aussi ce tag : <Link href={`/dashboard/topics?topic=${sharedTwin.id}`} className="font-medium text-primary hover:underline">{sharedTwin.name}</Link>. Votre fiche personnelle reste distincte.
      </p> : null}
      <p className="text-sm text-muted-foreground">{subscribed ? "Vous suivez ce topic : il fait partie de vos centres d’intérêt." : "L’abonnement ajoute ce topic à vos centres d’intérêt, sans créer de ΞAgent ni lancer de veille."}</p>
      <p className="text-sm text-muted-foreground">{known ? "Vous avez déclaré connaître ce sujet : il figure dans vos connaissances." : "Lire ou rechercher ce topic ne l’ajoute pas à vos connaissances : seule votre déclaration le fait."}</p>
      {topic.description ? <p className="whitespace-pre-wrap break-words text-[15px]">{topic.description}</p> : null}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground">Périmètre</h2>
        <p className="whitespace-pre-wrap break-words text-[15px]">{topic.scope}</p>
      </div>
      {topic.aliases.length ? <p className="text-sm text-muted-foreground">Anciens tags : {topic.aliases.map(alias => `#${alias}`).join(", ")}</p> : null}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href={networkHref({ layers: [], focus: topic.id, open: [topic.id], proposed: false })} className="font-medium text-primary hover:underline">Voir dans le réseau des topics</Link>
        {personal ? null : <Link href={`/dashboard/topics?topic=${topic.id}`} className="font-medium text-primary hover:underline">Fiche de gestion</Link>}
      </p>
    </section>
    <ResultSection id="topic-hierarchy" title="Hiérarchie">
      {parent || children.length ? <ul>
        {parent ? <TopicItem topic={parent} note="parent" /> : null}
        {children.map(child => <TopicItem key={child.id} topic={child} note="spécialisation" />)}
      </ul> : <p className="px-3 text-sm text-muted-foreground">Topic racine, sans spécialisation.</p>}
    </ResultSection>
    <TopicRelationsSection topic={topic} relations={relations} viewer={viewer.id} candidates={topics.filter(t => t.id !== topic.id)}
      error={relationError ? RELATION_ERRORS[relationError] : undefined} />
    <ResultSection id="topic-agents" title="ΞAgents spécialisés">
      {experts.length ? <ul>{experts.map(({ agent, role }) => <AgentItem key={agent.id} agent={agent} note={`topic ${role}`} />)}</ul>
        : <p className="px-3 text-sm text-muted-foreground">Aucun ΞAgent visible n’est spécialisé sur ce topic.</p>}
    </ResultSection>
    <ResultSection id="topic-inferred" title="Associations inférées">
      <p className="px-3 pb-1 text-xs text-muted-foreground">Publications publiques que Ξ a rapprochées de ce topic sans que leur auteur l’ait déclaré : terme explicite reconnu, ou concept identifié par un modèle local.</p>
      {inferred.length ? <ul>{inferred.slice(0, 20).map(({ publicationId, concept, model }) => (
        <li key={publicationId} className="space-y-0.5 rounded-xl px-3 py-2" aria-label="Association inférée">
          <Link href={`/dashboard/publications/${publicationId}`} className="text-sm font-medium text-primary hover:underline">Ouvrir la publication</Link>
          <p className="text-xs text-muted-foreground">{concept.match === "explicit" ? `Terme explicite (${VIA[concept.via]})` : `Concept « ${concept.label} » identifié par le modèle local ${model ?? ""}`}{concept.from.startsWith("publication:") ? "" : " · dans une source citée"}</p>
          <blockquote className="border-l-2 pl-2 text-sm break-words">« {concept.excerpt} »</blockquote>
        </li>))}</ul>
        : <p className="px-3 text-sm text-muted-foreground">Aucune association inférée.</p>}
    </ResultSection>
    <KonstruktorPanel target={{ type: "topic", id: topic.id }} intro={`Affinez le topic #${topic.tag} : nom, périmètre ou description.`} />
    <h2 className="border-b px-4 pt-3 pb-2 text-lg font-bold">Publications déclarées</h2>
    <PublicationFeed viewer={viewer} scope={{ kind: "search", topicIds: [topic.id], origin: "declared" }} cursor={cursor} path={topicHref(topic.tag)} label={`Publications déclarées sur ${topic.name}`}
      empty={{ title: "Aucune publication", description: "Aucune publication accessible ne déclare encore ce topic." }} />
  </>;
}
