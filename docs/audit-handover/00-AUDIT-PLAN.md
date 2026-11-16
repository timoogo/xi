# Plan d'audit — phase 0

Référence : `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Tous les statuts seront provisoires jusqu'à confrontation des phases. Avant chaque lot : lire l'état et ses checkpoints, vérifier HEAD et les modifications ; si HEAD diverge, suspendre et demander une décision. Documenter commandes, sources, résultats, limites et prochaine action dans `work/`, sans secrets. N'utiliser aucune donnée réelle pour les tests. Une preuve de nom, de documentation ou de test mocké ne suffit pas à établir un parcours opérationnel.

## Phase 1 — Histoire

- **H1 — périodes et références** : 61 commits accessibles, branches, tags et merges ; dépendance : phase 0. Grouper `git log --all --graph`, dates et changements par répertoire ; preuves : SHAs, parents, dates, refs et limites ; fin : chronologie des périodes et branches, zones incertaines identifiées.
- **H2 — intégrations et PR** : changements structurants, retraits, éventuelles releases et PR accessibles ; dépendance H1. Comparer les branches à `main`, rechercher PR et jalons documentés, sans fetch implicite ; preuves : diffs et métadonnées PR si accessibles ; fin : `04-HISTORICAL-TIMELINE.md`, statut de l'accès distant et références exactes. Séparer développé, intégré, testé et validé.

## Phase 2 — Architecture

- **A1 — socle** : entrées Next, configuration, auth, comptes, SQLite, migrations, stockage ; dépendance phase 0. Tracer routes vers services et données, frontières de confiance et configuration ; preuves : fichiers et lignes ; fin : carte de flux et zones non déterminées.
- **A2 — domaines et exécution** : Topics, recherche/graphe, publications, agents, Konstruktor, LLM, veille/worker et UI ; dépendance A1. Tracer appels et état jusqu'à persistance et traitements asynchrones ; distinguer mocks, interfaces et implémentations ; preuves : points d'entrée, appels, schémas, diagrammes ; fin : `02-ARCHITECTURE.md` avec statut provisoire de chaque composant.

## Phase 3 — Inventaire fonctionnel

Pour chaque lot, dépendances A1/A2 et H1/H2 ; relier entrée → traitement → données → sortie, tests et historique, conserver identifiant stable, attentes, limites et preuves. Fin de chaque lot : matrice suffisamment précise pour qualification ultérieure, sans conclure à la validation.

- **F1** : authentification, comptes, interface, avatars ; suivre sessions, droits et parcours.
- **F2** : Topics, recherche, graphe et connaissances ; examiner données, accès, indexation et provenance.
- **F3** : publications, conversations, mentions et sources ; examiner parcours, éditions et interactions.
- **F4** : ΞAgents, agents système et Konstruktor ; examiner création, configuration, tâches et coordination.
- **F5** : modèles IA, veille, arbitrage, pipeline, planification et supervision ; examiner appels réels, persistance, reprise et erreurs.
- **F6** : prototype et éléments de vision non couverts ; comparer branches et produit, rechercher explicitement les capacités annoncées, dont visuels locaux, sans conclure à l'absence prématurément. Fin globale : `03-FEATURE-INVENTORY.md`, traçabilité code → historique → tests → résultat → statut provisoire.

## Phase 4 — Vérifications

- **V1 — sécurité et prérequis** : dépend de A1/A2. Lire les helpers de test, chemins de bases/vault, appels réseau et scripts ; vérifier versions et dépendances installées sans installer. Preuves : chemins isolés et effets documentés ; fin : liste explicite des commandes sûres, indisponibles et conditions d'exécution.
- **V2 — suites et contrôles** : dépend V1. Exécuter uniquement les suites sûres et pertinentes, lint, typecheck et build avec configuration jetable et isolation démontrée ; navigateur et intégrations réelles seulement si sûrs et disponibles. Relever commande, cwd, environnement non secret, durée, sortie, décompte et code ; distinguer échecs et blocages. Comparer CI accessible et configuration. Fin : `06-VALIDATION-EVIDENCE.md`, y compris non exécutés et limites ; vérifier l'état Git.

## Phase 5 — Qualification et milestones

- **Q1 — fonctionnalités** : dépend F1–F6 et V2 ; appliquer les sept statuts de la mission, confiance et preuves pour chaque entrée, sans confondre mocks et intégration ; fin : inventaire qualifié, lacunes explicites.
- **Q2 — jalons** : dépend Q1 et H2 ; distinguer jalons historiques nommés et regroupements reconstruits ; preuves, dépendances et critères de clôture ; ne marquer terminé que si toutes les capacités obligatoires sont validées ; fin : `05-MILESTONES.md`.

## Phase 6 — Risques et candidats Linear

- **R1 — dette et risques** : dépend A2, Q1 et V2 ; analyser éléments probants, impact, gravité, certitude et alternatives, distinguer hypothèses et observations ; fin : `07-TECHNICAL-DEBT-AND-RISKS.md`.
- **R2 — sujets de cadrage** : dépend R1/Q2 ; regrouper fonctionnalités partielles, défauts, fiabilisation, futur et décisions en sujets de niveau produit avec preuves, dépendances et critères ; fin : `08-LINEAR-BACKLOG-CANDIDATES.md`, sans modification de Linear ni estimation arbitraire.

## Phase 7 — Passation et contrôle

- **D1** : dépend Q2/R2 ; rédiger `01-PRODUCT-OVERVIEW.md`, `09-OPEN-QUESTIONS.md` et `10-HANDOVER-GUIDE.md` pour le Scrum Master ; croiser et corriger les documents précédents avec les preuves.
- **D2** : vérifier statuts, preuves, jalons, références Git/fichiers, cohérence, secrets, tests échoués et état Git ; produire bilan chiffré issu de l'inventaire ; fin : dossier complet et checkpoint final. Si un contrôle ne peut être réalisé, mentionner la limite et ne pas déclarer l'audit complet.

Les lots peuvent être subdivisés selon les découvertes et suspendus entre sessions. L'ordre de lancement après autorisation : H1, puis H2 ; aucune phase ultérieure ne démarre dans cette première session.
