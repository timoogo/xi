# Publications Markdown (phases 1 et 2)

## Emplacement

Le vault Obsidian est configuré côté serveur par `XI_VAULT_PATH` (chemin absolu, jamais transmis au navigateur). Il doit exister ; Xi ne crée que `posts/` à l’intérieur et ne touche à aucun autre fichier du vault.

```text
<vault>/posts/
├── _users/<userId>/                 # espace isolé par ID Better Auth (stable, jamais le pseudonyme)
│   ├── post_20261019_001/
│   │   ├── index.md
│   │   ├── 1_annonce_reforme.md
│   │   ├── _sources/1_article_le_monde.md
│   │   └── _assets/                 # réservé, non servi pour l’instant
│   └── thread_20261019_002/
└── .trash/<userId>/<publicationId>/ # corbeille privée (dossier caché pour Obsidian)
    ├── trash.json                   # {id, folder, originalPath, trashedAt}
    ├── post_20261019_003/           # dossier complet, intact
    └── removed-messages/            # messages retirés dans l’éditeur, horodatés
```

Les autres dossiers de `posts/` (par exemple `posts/Politiks/`) sont réservés aux futurs générateurs ; ils ne sont ni lus ni modifiés.

## Format

### `index.md`

```markdown
---
id: 7d5c1a8e-1f2b-4c3d-8e9f-0a1b2c3d4e5f   # UUID stable, indépendant du chemin
type: thread                               # post (1 message) | thread (plusieurs)
author_type: human                         # human | ai (réservé)
author_id: 2rOgXYpC64BLv89NunPedppUMplKBHJX
status: draft                              # draft | published
visibility: public                         # private | followers | public
created_at: 2026-10-19T10:00:00.000Z
updated_at: 2026-10-19T10:05:00.000Z
published_at: 2026-10-19T10:06:00.000Z     # absent tant que brouillon
score: 0.8                                 # facultatif, jamais écrit par l’éditeur
---

Résumé en Markdown, [[liens]] Obsidian conservés.

![[posts/_users/<userId>/thread_20261019_002/1_contexte]]
![[posts/_users/<userId>/thread_20261019_002/2_analyse]]
```

- Les lignes `![[…]]` isolées qui visent un fichier numéroté du dossier sont les messages, dans cet ordre. Tout le reste du corps est le résumé, y compris les autres embeds.
- Les cibles sont des chemins complets depuis la racine du vault : chaque publication contient des `1_….md`, un nom court serait ambigu pour Obsidian.
- Les propriétés inconnues et les commentaires YAML ajoutés dans Obsidian sont conservés (le frontmatter est modifié via un document `yaml`, pas régénéré).

### Messages `{position}_{resume_snake_case}.md`

Contenu Markdown libre, terminé par une section `## Sources` listant des liens vers `_sources/` :

```markdown
Texte du message…

## Sources
- [[posts/_users/<userId>/post_20261019_001/_sources/1_article_le_monde|Article Le Monde]] — Le Monde
```

Le nom est fixé à la création (premier contenu non vide) et ne change plus ; le numéro est celui de création, l’ordre affiché vient de `index.md`. Le texte est écrit tel quel (frontmatter éventuel compris).

### Notes sources `_sources/{n}_{titre}.md`

```markdown
---
type: source
url: https://www.lemonde.fr/…
title: Article
publisher: Le Monde
published_at: 2026-10-18    # facultatif
accessed_at: 2026-10-19
---
# Article

<https://www.lemonde.fr/…>

## Faits utilisés
- …

## Réserves
_Aucune._
```

Tous les champs viennent de l’auteur (URL http(s) originale, titre, éditeur et au moins un fait obligatoires). Xi ne complète ni n’invente aucune référence.

## Décisions d’architecture

- **Source de vérité : les fichiers.** La table SQLite `publication` (même base que Better Auth) n’est qu’un index reconstructible : ID → dossier, métadonnées pour les listes. Elle ne contient aucun contenu et peut être supprimée.
- **Synchronisation.** À chaque lecture, l’index de l’utilisateur concerné est réconcilié avec le disque (re-lecture de `index.md` si son mtime change). Les renommages ou déplacements dans Obsidian sont retrouvés par `id`, les dossiers supprimés retirés de l’index. Le contenu servi et les permissions sont toujours relus depuis les fichiers.
- **Révision et conflits.** La révision est le SHA-256 de tous les `.md` du dossier, calculé sur les octets mêmes renvoyés au client. Une sauvegarde n’écrit rien si le disque a changé depuis ; l’éditeur affiche la version des fichiers et l’auteur choisit de la charger ou d’imposer la sienne (explicitement, contre la révision qu’il a vue).
- **Écritures atomiques.** Fichier temporaire caché dans le même dossier, `fsync`, puis `rename`. Les messages sont écrits avant `index.md`. Un verrou par publication sérialise les écritures du processus.
- **post_ / thread_.** Le type suit le nombre de messages. Le dossier d’un brouillon est renommé en conséquence et ses liens internes réécrits ; un dossier publié garde son nom pour ne pas casser les liens extérieurs. L’`id` ne change jamais.
- **Permissions (store, côté serveur).** Lecture : l’auteur, ou tout membre connecté si `published` + `public`. Brouillon : toujours privé. `followers` : auteur et membres abonnés, selon les préférences Markdown actuelles. Édition, corbeille, restauration : l’auteur seul. Une publication illisible répond 404, comme une inexistante.
- **Chemins.** Le client ne transmet jamais de chemin : seulement un UUID et des noms de messages validés (`^\d+_[a-z0-9_]+\.md$`) qui doivent appartenir à la publication. Les segments sont validés, les liens symboliques résolus et refusés hors de `posts/`, et le dossier comme le frontmatter doivent désigner le même auteur.
- **Rien n’est servi directement** : pas de route statique sur le vault. Le Markdown est rendu sans HTML brut, URLs assainies, images distantes non chargées ; les wikilinks sont affichés sans être interprétés par le parseur.
- **Corbeille.** Déplacement du dossier entier vers `posts/.trash/<userId>/<id>/` ; la publication quitte immédiatement l’index public. Restauration à l’emplacement d’origine, ou sur un nouveau numéro (liens réécrits) si l’emplacement est occupé. Aucune purge automatique. Les numéros de dossier ne sont jamais réutilisés, corbeille comprise.
- **Éditeur.** Mode visuel par blocs (Markdown rendu, édition au clic avec barre de mise en forme qui insère la syntaxe), Markdown brut, aperçu. Pas de WYSIWYG ProseMirror : leurs sérialiseurs réécrivent `[[…]]` et le frontmatter. Les brouillons s’enregistrent automatiquement (1,5 s) dans les fichiers ; une publication publiée ne change que sur « Save changes ».
- **Déplacement futur (Raspberry Pi).** Tout passe par `XI_VAULT_PATH` et des chemins relatifs au vault (liens, index, `trash.json`) : changer l’emplacement ne touche pas la logique métier.

## Fil et routes

- `/dashboard` (accueil) : deux fils, « Pour vous » (préférence explicite, alternance des auteurs, score et fraîcheur) et « Abonnements » (chronologique). Les publications doivent être lisibles et non masquées. Voir [le contrat du fil](feed.md).
- `/dashboard/profile` : tes publications publiées. `/dashboard/publications` : tes brouillons et publications. `/dashboard/publications/trash` : ta corbeille.
- `/dashboard/publications/<id>` : page de détail (thread complet, sources dépliées) ; `…/edit` : éditeur, auteur seul.
- Chaque entrée est un `PublicationCard` lisible sur place : auteur, date, Markdown rendu par `MarkdownView`, messages d'un thread reliés, sources repliables, visibilité non publique signalée. Au-delà de 3 messages ou de 1 500 caractères par bloc, la carte est tronquée avec un lien vers la page complète.
- Pagination par curseur (`?cursor=`), 20 publications par page. Le curseur associe une empreinte de l’ordre autorisé et le dernier UUID ; un changement de classement provoque une reconstruction de la portion chargée, jamais une continuation avec un décalage périmé. Chaque élément est relu depuis ses fichiers et ses permissions re-vérifiées.
- Actions disponibles : répondre, partager le lien, sources et connexions du graphe. L’auteur dispose de Modifier (ou Corriger pour une analyse publiée) et Supprimer. Les actions aimer, enregistrer, approfondir et fork ne sont pas affichées.

## Suppression et restauration

Supprimer (depuis une carte, la page de détail ou l'éditeur) demande une confirmation, enregistre d'abord les modifications en attente de l'éditeur, puis déplace le dossier dans la corbeille. Le toast propose « Undo ». L'ancienne URL affiche « Publication unavailable » (404). La restauration reprend le dossier d'origine s'il est libre ; sinon un nouveau numéro est attribué, les liens internes sont réécrits et le message l'indique. Le contenu qui occupe l'emplacement d'origine n'est jamais touché.

## Limites connues

- Fenêtre de course résiduelle entre la vérification de révision et l’écriture si Obsidian écrit exactement à ce moment ; une instance Xi unique est supposée (verrou en mémoire).
- Surveillance des dossiers du vault, réconciliation périodique de secours toutes les 60 secondes et SSE. Une interruption réseau retarde la mise à jour jusqu’à la reconnexion.
- Les médias `_assets/` ne sont ni téléversables ni affichés.
- Les messages retirés restent dans `removed-messages/` sans interface de restauration.

### Réponses et branches

Un message peut déclarer `reply_to: <uuid-publication>/<numéro-immuable>` dans son frontmatter YAML. Une référence vers un message de la même publication crée une branche secondaire ; les autres messages conservent l’ordre des inclusions de `index.md`. Une réponse publiée séparément peut aussi déclarer ce champ dans `index.md` (il s’applique au premier message). Les fichiers Markdown restent la source de vérité.

Les numéros de fichiers, et donc les liens `#m-<numéro>`, restent stables lors du réordonnancement. Les références manquantes ou cycliques ne suppriment jamais de contenu : leurs messages restent dans le fil principal. Le fil d’accueil montre trois messages principaux au maximum ; les branches sont consultables sur la page complète. Les liens directs ouvrent automatiquement les branches qui contiennent le message ciblé.
