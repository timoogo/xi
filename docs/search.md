# Recherche universelle

Champ de recherche du panneau de découverte et page `/dashboard/explore?q=` (formulaire GET, sans JavaScript, accessible sur mobile).

## Syntaxe (`src/lib/search/query.ts`)

- `transport` : texte libre. Publications contenant tous les termes (index plein texte, voir plus bas), classées par pertinence ; topics et ΞAgents visibles dont le nom ou le périmètre correspond (classement déterministe `ranked` de `topics/analysis.ts`, inchangé).
- `#transport` : référence à un topic. Normalisation : accents retirés, minuscules, caractères hors `[a-z0-9-]` remplacés par `-` dans chaque segment pointé.
- `@agent` : référence à un ΞAgent par son handle, normalisé de la même façon.
- Plusieurs `#` : recherche croisée. Publications associées à **chacun** des topics, et liens directs déclarés (parent, relation) entre eux. Une co-occurrence n’est jamais présentée comme une relation entre topics.
- Texte et `#` combinés : publications contenant les termes **et** associées à tous les topics. Un `#tag` non résolu ne renvoie aucune publication.
- Une référence invalide (`#`, `#2026`) reste du texte. Dix références de chaque type au plus, 300 caractères.

Les publications n’ont jamais besoin de hashtags : `#` désigne uniquement un topic.

## Résolution (`src/lib/search/resolve.ts`)

Correspondances explicites et déterministes uniquement : tag actuel, ancien tag (alias), puis dernier segment porté par un seul topic (`#france` → `politiks.france`). Une ambiguïté n’est jamais tranchée : les topics proches sont proposés. Une requête limitée à une seule référence résolue ouvre directement le topic ou le profil du ΞAgent.

Données lues (`src/lib/search/server.ts`) : le catalogue partagé de topics et les ΞAgents visibles par l’utilisateur (publics ou possédés), comme dans `accounts.list`. Un ΞAgent privé d’un autre utilisateur n’est ni résolu ni suggéré.

## Index plein texte et associations (`src/lib/publications/index-db.ts`, schéma 7)

Tables dérivées du vault, reconstruites avec les autres tables d’index (changement de version, `pnpm graph:reindex`) ; aucun fichier Markdown n’est modifié.

- `publication_fts` (FTS5, `rowid` = celui de `publication`) : résumé et corps complets des messages vivants, sans frontmatter ni balisage (`plainText`). Le texte est normalisé par `src/lib/search/text.ts` à l’indexation comme à la requête : accents et casse ignorés ; pluriels courants réduits (`-s`, `-x`, `-eaux` → `-eau`, `-aux` → `-al`), sauf mots de trois lettres ou moins et finales en `-ss`. Aucune synonymie. Les mots très fréquents (articles, prépositions) sont ignorés dans les requêtes. Chaque terme de requête est cité : aucune syntaxe FTS ne peut être injectée. Classement `bm25`, puis ordre chronologique.
- `publication_topic(publication_id, topic_id, role, origin, score)` : associations par UUID immuable de topic. `origin = 'declared'` provient du frontmatter (`primary_topic` → `primary`, `topics` → `secondary`). `origin = 'inferred'` et `score` sont réservés aux associations inférées, dont la source durable sera hors de la publication (lot 5) : elles devront être réécrites depuis cette source après une reconstruction.

Les résultats passent par `store.page` (portée `search`) : filtre SQL `readablePublicationSql`, publications publiées seulement, puis relecture des fichiers et nouveau contrôle `canRead` avant affichage. La corbeille et les publications privées d’autrui n’apparaissent jamais.

## Page Topic

`/dashboard/topics/<tag>`, en lecture seule : nom, description, périmètre, anciens tags, parent et spécialisations, relations déclarées (affichées depuis les deux extrémités), ΞAgents visibles spécialisés sur le topic (principal ou secondaire), publications lisibles associées au topic par son UUID (les anciens tags y mènent donc aussi), lien vers le graphe et vers la fiche de gestion. Les publications des spécialisations ne sont pas agrégées. Un ancien tag redirige vers le tag actuel ; un tag inconnu redirige vers la recherche, qui propose les topics proches ; un tag malformé répond 404.

Pas encore disponibles : associations inférées, promotion des topics personnels.

## Vérification

`pnpm test:topics` (inclut `tests/search.test.ts` et `tests/search-publications.test.ts`) et `pnpm test:topics:e2e` (inclut `tests/search-browser.test.ts`, build de production requis).

## Topics personnels (lot 3)

Soumettre une recherche composée d’un seul `#tag` qui ne correspond à aucun topic visible et n’est pas ambigu ouvre la fiche personnelle de ce tag, créée si besoin (`searchTarget`, Server Action `submitSearch`). La création n’a lieu que sur une soumission explicite (POST) : ni pendant la frappe, ni sur un GET, ni sur un préchargement. Depuis les résultats, « Créer et ouvrir ma fiche personnelle » fait de même, y compris pour un tag ambigu que l’utilisateur choisit de garder. Ouvrir l’URL d’un tag inconnu ne crée rien : elle redirige vers la recherche.

- Stockage : `.xi-personal-topics/<userId>/<UUID>.md` (dossiers 0700), même schéma que les topics communs plus `owner`. Ni `topics/`, ni `topic_index`/`topic_tag`, ni `GET /api/topics`, ni les ΞAgents (qui n’acceptent que le catalogue commun) ne les voient. Les lectures passent par le même verrou d’écriture que le catalogue.
- Création idempotente par (propriétaire, tag), sérialisée par le verrou : des soumissions concurrentes obtiennent le même UUID. Un topic personnel reste une racine sans relation ; la hiérarchie sera décidée lors d’une promotion.
- Collisions : un topic commun portant le tag (actuel ou ancien) l’emporte toujours à la création, aucun doublon personnel n’est créé. Un topic personnel ne réserve rien dans le catalogue commun : un topic commun peut prendre ce tag plus tard. Pour son propriétaire, le topic personnel répond alors en premier à ce tag et sa page signale le topic commun homonyme ; les autres utilisateurs obtiennent le topic commun.
- Promotion (non implémentée) : déplacer le fichier dans `topics/` en conservant l’UUID (abonnements et associations de publications restent valides), après validation du tag contre le catalogue commun et choix éventuel d’un parent.

## Abonnements

`topics: [UUID]` dans `posts/_users/<userId>/feed.md`, le fichier des abonnements aux auteurs, écrit sous le même verrou (`store.setTopicSubscription`, Server Action `toggleTopicSubscription`). Idempotent, propre à chaque utilisateur, limité aux topics qu’il peut voir (sinon 404). Un abonnement à un topic devenu invisible est conservé mais ignoré. Les abonnements forment le futur layer « Mes centres d’intérêt » (`subscribedTopics`) et sont listés dans « Sujets suivis » ; ils ne créent aucun ΞAgent, ne planifient aucune veille et ne publient rien.
