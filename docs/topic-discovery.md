# Découverte et enrichissement des Topics (lot 5)

Code : `src/lib/topics/discovery.ts`. Job `enrich-publication` de la queue `watch_job`, exécuté par le worker
(`scripts/watch-worker.ts`), jamais par une requête web : publier ne bloque jamais sur l'analyse.

## Connaissances des ΞAgents

À chaque passage, le worker planifie aussi une tâche interne Konstruktor `publication-knowledge` pour chaque
publication réelle d’ΞAgent, publique ou privée, et chaque révision.

Ces tâches sont regroupées en **pipelines** (`src/lib/konstruktor/pipelines.ts`, page *Konstruktor → Pipelines*) :
un run automatique par ΞAgent quand le worker trouve du travail nouveau, ou un run manuel (publications
manquantes, ou réanalyse complète). Un run n’est qu’un plan persistant (`konstruktor_pipeline_run`,
`konstruktor_pipeline_job`) sur la même file `watch_job` : états, tentatives, baux et logs restent ceux du moteur
(`xiagent_run`). Un seul run actif par ΞAgent ; « Relancer les échecs » crée de nouvelles tâches pour les seules
publications en échec, le worker ne relance jamais un échec de lui-même. Après un redémarrage, une tentative dont
le bail expire est marquée `interrupted` puis reprise. Runs et logs ne sont lisibles que par leur propriétaire. Les publications de test sont exclues.
La clé de tâche associe propriétaire, ΞAgent, publication et révision ; une relance ne duplique ni topic ni relation.
Le modèle local du ΞAgent (ou celui hérité du propriétaire) propose des concepts avec citations exactes. Les concepts déjà visibles sont
réutilisés ; les autres deviennent des topics personnels, jamais des topics partagés. Les relations ne sont
créées qu’avec une citation présente et des indices explicites, au statut **proposé**, sans les présenter comme
des faits vérifiés. Elles restent privées et leur preuve suit les permissions de la publication.

L’index SQLite `xi_agent_knowledge` conserve l’association ΞAgent–publication–topic et l’extrait source ; le
réseau des topics affiche ces contributions au propriétaire. Les citations sont visibles sur la fiche du topic,
uniquement tant que la publication est lisible et à la révision analysée. Les publications ne sont jamais bloquées
par ce traitement ; les erreurs restent dans les tâches du worker. Le worker doit être actif pour les traiter.

Quand le propriétaire sollicite son ΞAgent en commentaire, `generate()` ajoute au contexte du modèle au plus 20
extraits de cet index dont le concept est nommé dans la conversation (tags, alias, noms ; pas d’embeddings), avec
leur publication source et la mention « non nécessairement vérifiés ». Le filtrage est fait côté serveur avant le
prompt : jamais pour un autre utilisateur, sources publiées, lisibles et à la révision analysée, et uniquement des
sources publiques hors d’une conversation privée. La rédaction de publications n’utilise pas cette mémoire.

## Ce qui est analysé

Uniquement les publications **publiques, publiées, hors contenus de test** : leur texte (résumé et messages, hors
section « Sources ») et les sources analysées qu'elles citent (titre, extraits, faits). Une publication privée ou
réservée aux abonnés n'est jamais lue ; une publication qui cesse d'être publique perd ses associations inférées.
Seul le catalogue commun est utilisé : un Topic personnel n'est jamais reconnu, révélé ni promu.

## Pipeline

1. **Planification** (à chaque passage du worker) : un job par publication dont le contenu n'a pas encore
   d'enregistrement ou a changé ; clé `enrich:<publication>:<révision>`, donc idempotente. Un enregistrement fait sans
   modèle reçoit une seconde passe `…:model` dès que le modèle local du propriétaire est disponible.
2. **Termes explicites** (toujours, sans modèle) : hashtags, tags, anciens tags et noms de Topics écrits dans le texte,
   comparés terme à terme après normalisation (casse, accents, pluriels, ponctuation).
3. **Inférence locale** (modèle du propriétaire : l'auteur humain, ou le propriétaire du ΞAgent auteur ; résolution
   `llm/server.ts`, serveurs locaux uniquement, aucun repli cloud) : concepts et relations, chacun avec une phrase
   recopiée du texte. Une citation introuvable dans le texte est ignorée.
4. **Résolution** : un concept est rapproché d'un Topic par sa clé normalisée (tag, ancien tag, nom). Les variantes
   orthographiques ont la même clé : jamais de doublon. Sans Topic, il reste un concept.
5. **Relations** : seulement entre deux Topics communs identifiés, via `relations.propose()` (lot 4), avec type,
   justification du modèle, preuve citée (`source` si la phrase figure dans une source citée, sinon `publication`),
   indice `cooccurrence`, provenance `local-model:<modèle>` et confiance évaluée.

Reprise : bail et jeton de la queue ; un job interrompu est repris par le passage suivant, et tout est idempotent
(enregistrement réécrit, `propose()` renvoie la relation existante). Modèle injoignable : le job attend sans consommer
de tentative ; réponse invalide : nouvelle tentative avec délai. Les jobs partagent `XI_INFERENCE_CONCURRENCY`.

## Confiance

Quatre composantes évaluées séparément, la confiance retenue est **la plus faible** :

| Composante | Valeurs |
|---|---|
| sources | 0,4 sans source citée, 0,6 avec une, 0,8 avec deux ou plus ; +0,1 si la phrase vient d'une source (max 0,9) |
| preuve | 1 si la phrase nomme les deux Topics, 0,6 un seul, 0,3 aucun |
| inférence | certitude déclarée par le modèle, plafonnée à 0,9 |
| type | 1 si la phrase contient une formulation du type (influence, appartenance, opposition, similarité), 0,3 sinon, 0,7 pour « lié à » |

Ces scores ne sont pas calibrés sur des données annotées : par défaut, **toute relation inférée reste « proposée »**.
`XI_TOPIC_AUTOACCEPT=true` (décision d'opérateur après calibration) applique le seuil 0,8 du lot 4.
Une relation exclue, ou corrigée vers un autre type, n'est reproposée qu'avec une preuve nouvelle (autre source ou
autre publication pour la même phrase), et seulement au statut « proposée ».

## Persistance

- `topic-discovery/<publication>.md` : révision analysée, mode (`model` ou `deterministic`), modèle, pipeline,
  concepts (clé, libellé, Topic, correspondance explicite ou inférée, extrait, origine), issue de chaque relation.
- Relations : `topic-relations/` (lot 4).
- SQLite : lignes `publication_topic` d'origine `inferred`, reconstruites depuis les enregistrements à chaque passage
  (`project()`), y compris après une reconstruction complète des index. Une association déclarée l'emporte toujours.

## Candidats Topics

Concepts sans Topic commun, regroupés par clé normalisée. Vu dans au moins 3 publications de 2 auteurs : « candidat à la
création », sinon « observé ». Affichés avec leurs preuves sur `/dashboard/topics` ; aucun Topic n'est créé
automatiquement.

## Confidentialité des preuves

Les permissions sont vérifiées **à l'affichage**, pas seulement à l'extraction. Quand une publication devient privée,
quitte l'état publié, part à la corbeille ou disparaît :

- ses associations inférées sont retirées de `publication_topic` dès la réindexation de la publication, et
  l'enregistrement `topic-discovery/<publication>.md` (extraits compris) est supprimé au passage suivant du worker ;
  republiée, elle est réanalysée ;
- les fiches Topic et les candidats ne lisent que les enregistrements de publications publiques à leur révision analysée ;
- chaque preuve d'une relation porte sa publication (`publication`, ou la référence `publication:<id>`). Pour un
  lecteur qui ne peut pas lire cette publication, la preuve est masquée (type seul) et la justification remplacée ;
  une relation automatique dont aucune publication n'est lisible n'est montrée qu'aux créateurs des Topics, sans
  contenu, pour qu'ils puissent la corriger ou l'exclure ; pour les autres, elle n'existe pas (404, pas 403) ;
- l'historique (actions, dates, auteurs, motifs humains), le type, le statut et la confiance restent dans le fichier de
  la relation : les corrections et exclusions survivent ;
- la projection SQLite `topic_relation` ne contient que la structure ; `topic_relation_basis` relie chaque relation à
  ses publications, et `readableStructure(viewer)` filtre en SQL avec `readablePublicationSql` (base du graphe, lot 6).

