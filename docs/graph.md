# Graphe de connaissances

Le Markdown du vault est la source de vérité ; SQLite n’en est qu’un index reconstructible (`pnpm graph:reindex`). Les contrats TypeScript partagés sont dans `src/lib/graph/types.ts`. La même page offre un second mode, le réseau des topics : voir [topic-network.md](topic-network.md).

## Niveaux et identifiants immuables

| Niveau | Fichier | Identifiant | Nœud |
| --- | --- | --- | --- |
| Générateur | `generators/<slug>/index.md` | `id` (UUID du frontmatter) | `g:<uuid>` |
| Publication | `posts/_users/<userId>/<dossier>/index.md` | `id` (UUID du frontmatter, inchangé) | `p:<uuid>` |
| Message | `{n}_{slug}.md` dans la publication | `<publicationUuid>/<n>` | `m:<uuid>/<n>` |
| Relation | `relations/<uuid>.md` | `id` (UUID du frontmatter) | — |

Les identifiants YAML font autorité sur les noms de dossiers et de fichiers. Le numéro `n` d’un message n’est jamais réutilisé dans sa publication, même après retrait du message (les numéros de `removed-messages/` sont réservés).

## Générateurs

Hiérarchie logique, organisation physique plate : jamais de sous-dossiers.

```text
generators/
  politiks/index.md
  politiks.france/index.md
  politiks.france.elections/index.md
  sciencia/index.md
```

```markdown
---
id: 1b4e28ba-2fa1-41d2-883f-0016d3cca427
slug: politiks.france          # fait autorité (le nom du dossier n’est qu’un indice)
title: Politiks · France
owner_id: <userId Better Auth>
visibility: public             # private | followers | public
created_at: 2026-10-19T10:00:00.000Z
---
Description libre.
```

- Parent (`parent`) : le générateur existant le plus proche dont le slug est un préfixe pointé (`politiks.france.elections` → `politiks.france`, ou `politiks` si `politiks.france` n’existe pas).
- Doublons d’`id` ou de `slug` : le premier dossier par ordre alphabétique l’emporte, les autres sont ignorés.
- Fichier invalide (YAML, slug, visibilité, propriétaire) : ignoré.

## Rattachement des publications (`belongs_to`)

Propriété facultative dans le frontmatter d’`index.md` d’une publication : `generator: <uuid du générateur>`. L’éditeur la conserve (propriété inconnue). Elle n’est prise en compte que si l’auteur de la publication peut lire ce générateur ; sinon, comme en son absence, la publication apparaît sous la racine virtuelle « Sans générateur » (`g:unassigned`).

## Messages (`reply_to`)

Dans un fil, chaque message répond au précédent selon l’ordre d’`index.md`. Aucune modification du format des messages.

## Relations sémantiques

Types : `supports`, `contradicts`, `expands`, `related_to`, `updates`. Directionnelles (`source` → `target`), consultables depuis les deux extrémités sans inverser le sens.

```markdown
---
id: 9f0c…
type: supports
source: <publicationUuid>/<n>
target: <publicationUuid>/<n>
status: validated        # proposed | validated | rejected
needs_review: false      # signalement d’obsolescence, n’altère pas status
origin: human            # human | ai
created_by: <userId ou uuid de générateur>
created_at: 2026-10-19T10:00:00.000Z
validated_by: <userId>   # absent tant que non validée
validated_at: 2026-10-19T10:00:00.000Z
---
Note libre.
```

Règles d’écriture (`src/lib/graph/relations.ts`) :

- Seules les relations `validated` entrent dans le graphe. Une proposition IA est créée `proposed` et attend une validation humaine.
- Un humain crée (directement `validated`) ou valide/rejette une proposition s’il peut lire les deux messages et est l’auteur de la publication source.
- Une IA ne peut que créer des propositions et signaler `needs_review: true`. Elle ne modifie, ne rejette ni ne supprime jamais une relation validée.
- Aucune suppression automatique : une relation dont une extrémité disparaît reste dans le vault et est simplement masquée.

## Permissions

Appliquées côté serveur, sur l’index réconcilié avec le disque à chaque requête ; le contenu des messages est toujours relu depuis les fichiers.

- Générateur : propriétaire, ou tout membre connecté si `public` (`followers` = propriétaire seul, faute de modèle d’abonnement). Un générateur illisible masque tout son sous-arbre de générateurs.
- Publication et message : règles existantes (`src/lib/publications/permissions.ts`), corbeille exclue.
- Relation : visible seulement si les deux messages existent et sont lisibles.
- Agrégations, compteurs, nombres d’enfants : calculés uniquement sur les données autorisées ; une ressource illisible répond 404 comme une inexistante.

## Agrégation

Chaque extrémité de relation est projetée sur son ancêtre-ou-soi affiché le plus profond (message → publication → générateurs → racine). Deux projections distinctes donnent une arête agrégée (total, sens a→b / b→a, par type, `needs_review`) ; une projection identique ne donne aucune arête. Les compteurs d’un nœud portent sur son sous-arbre : interne (deux extrémités dedans), externe (une seule), à réexaminer. Chaque relation compte au plus une fois par nœud et par arête.

## Index SQLite

Tables dérivées, dans la base Better Auth : `publication` (+ `generator_id`), `publication_message`, `graph_generator`, `graph_relation`, `publication_fts`, `publication_topic` (voir docs/search.md) et `xi_index_meta` (version de schéma). Un changement de version supprime puis reconstruit les tables d’index ; `pnpm graph:reindex` force une reconstruction complète. Aucune table d’index ne contient de données irremplaçables.
