import Link from "next/link";
import { CANDIDATE_AUTHORS, CANDIDATE_PUBLICATIONS, type DiscoveryRecords } from "@/lib/topics/discovery";

type Candidate = Awaited<ReturnType<DiscoveryRecords["candidates"]>>[number];

/** Concepts found in public publications without a shared topic. Read-only: creating a topic stays a human act. */
export function TopicCandidates({ candidates }: { candidates: Candidate[] }) {
  const shown = candidates.filter(c => c.status === "candidate").concat(candidates.filter(c => c.status === "observed").slice(0, 10));
  return (
    <section aria-labelledby="topic-candidates" className="border-t px-4 py-3">
      <h2 id="topic-candidates" className="text-lg font-bold">Concepts découverts</h2>
      <p className="mb-2 text-sm text-muted-foreground">
        Concepts relevés dans les publications publiques sans topic commun correspondant. Un concept vu dans au moins {CANDIDATE_PUBLICATIONS} publications
        de {CANDIDATE_AUTHORS} auteurs devient candidat ; aucun topic n’est créé automatiquement : créez-le ci-dessus après vérification des preuves.
      </p>
      {shown.length ? <ul className="space-y-2">{shown.map(candidate => (
        <li key={candidate.key} aria-label={`Concept ${candidate.labels[0]}`} className="rounded-xl border px-3 py-2">
          <p><span className="font-semibold">{candidate.labels.join(" · ")}</span>{" "}
            <span className="ml-1 rounded-full border px-1.5 text-xs">{candidate.status === "candidate" ? "candidat à la création" : "observé"}</span></p>
          <p className="text-xs text-muted-foreground">{candidate.publications} publication{candidate.publications > 1 ? "s" : ""}, {candidate.authors} auteur{candidate.authors > 1 ? "s" : ""}</p>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Preuves</summary>
            <ul className="mt-1 space-y-1">{candidate.evidence.map(e => <li key={e.publicationId}>
              <blockquote className="border-l-2 pl-2 break-words">« {e.excerpt} »</blockquote>
              <Link className="text-xs underline" href={`/dashboard/publications/${e.publicationId}`}>Ouvrir la publication</Link>
            </li>)}</ul>
          </details>
        </li>))}</ul>
        : <p className="text-sm text-muted-foreground">Aucun concept découvert pour l’instant.</p>}
    </section>
  );
}
