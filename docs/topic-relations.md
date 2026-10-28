# Relations Topic ↔ Topic (lot 4)

Relations durables entre Topics, distinctes des relations entre messages (`docs/graph.md`, règles inchangées).
Code : `src/lib/topics/relations.ts`. Interface : section « Topics liés » de `/dashboard/topics/<tag>`.

## Trois sortes de relations

| Sorte | Source de vérité | Modifiable ici |
|---|---|---|
| Hiérarchie parent/enfant | `parentId` des fiches `topics/<uuid>.md` | non (fiche de gestion) |
| Relation déclarée (historique) | `relatedIds` des fiches, validée par le créateur de la fiche | masquage personnel seulement |
| Relation enregistrée | `topic-relations/<uuid>.md` ou espace privé de l'utilisateur | oui |

Les deux premières sont lues telles quelles, jamais recopiées : les Topics existants restent compatibles sans migration.

## Format d'une relation enregistrée

Frontmatter YAML validé (fichier invalide ignoré, jamais réparé) :

- `id` (UUID), `source`, `target` (UUID de Topics, immuables), `type` : `related_to`, `similar_to`, `opposes`
  (symétriques, stockés avec `source < target`), `part_of`, `influences` (orientés).
- `status` : `proposed`, `accepted`, `excluded`.
- `origin` : `human`, `agent` (ΞAgent), `inference` (modèle local) ; `createdBy` : utilisateur, UUID de ΞAgent ou identifiant du modèle.
- `confidence` (0–1, null pour un humain), `justification`, `evidence` (`kind`, `ref`, `excerpt`).
- `createdAt`, `updatedAt`, `history` (créée, type corrigé, validée, exclue, rétablie, reproposée ; auteur, date, motif).
- `owner` : présent uniquement sur une relation personnelle.

## Où est écrite une relation humaine

- Entre deux Topics communs, par le créateur de l'un des deux : `topic-relations/<uuid>.md`, visible par tous.
- Sinon (autre utilisateur, ou Topic personnel impliqué) : `.xi-personal-topics/<user>/relations/<uuid>.md`, visible par lui seul.
  Une relation vers un Topic personnel ne peut donc jamais en révéler l'existence ni le promouvoir.

## Relations automatiques

`propose()` (ΞAgents, inférence locale ; extraction complète au lot 5) n'accepte que des Topics communs et exige :
une justification d'au moins 20 caractères et au moins une preuve substantielle (`publication`, `source`, `claim`)
avec extrait. Les indices `cooccurrence`, `shared_word`, `shared_agent` peuvent accompagner une preuve mais ne
suffisent jamais. Confiance ≥ 0,8 : acceptée ; sinon proposée, visible et validable par les créateurs des deux Topics.

## Corrections et exclusions

- Exclusion personnelle (tout lecteur, toute relation visible, y compris déclarée) :
  `.xi-personal-topics/<user>/relation-exclusions.md`, rétablissement tracé (`restoredAt`).
- Correction et exclusion globales : créateur de l'un des deux Topics (ou propriétaire d'une relation personnelle).
  Le fichier garde la relation avec son historique ; rien n'est supprimé.
- Une relation exclue n'est reproposée automatiquement qu'avec une preuve substantielle nouvelle, et seulement
  au statut `proposed`. Un humain peut la rétablir explicitement.

## Index

Table `topic_relation` : projection des seules relations communes, réécrite depuis le Markdown à chaque lecture
(lot 6 : vue réseau). La vider ou la supprimer ne perd rien.
