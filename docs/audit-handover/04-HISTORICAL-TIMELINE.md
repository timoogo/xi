# Chronologie historique provisoire — lot H1

Référence : `main` au commit `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Relevé local du 6 novembre 2026 ; 61 commits uniques accessibles par les références locales, dépôt non shallow. Aucun fetch. Les dates ci-dessous sont les dates des commits, pas des preuves de mise en production, de validation ou nécessairement de début du développement. Les commits cités comme présents sur `main` sont ses ancêtres ; pour les commits directs, leur date de commit ne permet pas de dater indépendamment leur intégration. Les résultats de la consultation distante H2 figurent dans la consolidation ci-dessous. Aucun comportement n'est ici qualifié de validé.

## Grandes périodes et changements documentés

### 2025-07-30 à 2025-08-28 — socle initial

`bf6f41c` est la racine « Initial commit from Create Next App » ; `7274082`, `3afef07` et `7b9ebad` constituent la suite de la première lignée. Il s'agit de la chronologie accessible, pas d'une preuve d'absence de travail entre août 2025 et octobre 2026. Les détails de l'origine du produit restent à approfondir en H2.

### 2026-10-20 — repère « mvp » et transformation du socle

`eeaa686`, intitulé exactement `mvp`, modifie 122 fichiers : son diff introduit notamment `src/lib/auth.ts`, `src/lib/publications/store.ts` et `vault.ts`, le répertoire `src/lib/graph/`, des routes de graphe, des pages de publications et des tests. Il supprime aussi plusieurs composants et jeux de données factices, dont `src/lib/dummy-data/tweets.ts`. Les ajouts et suppressions sont observables avec `git show --name-status eeaa686` ; leur usage actuel et leur fonctionnement restent à établir. `383f8e9` modifie ensuite `src/lib/graph/repository.ts`.

Une autre lignée contient `ccac3f1` (`mvp`) et `18285da`. Le premier inclut 428 fichiers d'artefacts `.next-graph` absents de `eeaa686` ; la comparaison des arbres est dominée par ces fichiers générés. `383f8e9` et `18285da` aboutissent au même arbre (`git diff --name-status 383f8e9 18285da` vide). Ce sont des traces historiques de lignées remaniées, à ne pas compter comme deux livraisons distinctes.

### 2026-10-22 au 2026-10-24 — flux social, Topics, agents et veille

- `9deac59` ajoute notamment des routes `api/feed`, `api/conversations` et `api/events`, ainsi que `docs/feed.md` ; `b781dd4` modifie plus tard la structure et l'affichage des conversations.
- `b3690b7` introduit notamment `docs/topics.md`, des routes et tests de Topics et des comptes éditoriaux. `d70a31c` ajoute `docs/xiagents.md`, des éléments ΞAgents et modifie les comptes éditoriaux : son diff matérialise une transition, sans établir la suppression complète de l'ancien modèle.
- `e173294` ajoute `scripts/watch-worker.ts` et des modules de collecte, évaluation, rédaction, publication et ordonnancement sous `src/lib/watch/`, accompagnés de tests ; cela établit l'apparition de ces éléments, pas une exécution autonome fiable.
- `c05ad4a` modifie la dépendance et les composants d'avatars ; `50d6475` étend en outre agents, veille, tests et documentation YAML. Les diffs touchent aussi le code, malgré le titre de ce dernier commit.

### 2026-10-25 au 2026-10-28 — modèles, prototype et découverte

- `4bdf533` ajoute `src/lib/llm/ollama.ts`, `inference.ts`, `store.ts`, des routes LLM et des liens avec la veille ; une intégration nominale ne prouve pas l'accès à un modèle réel.
- `a821710` ajoute les 28 fichiers suivis du prototype `prototypes/v0-xiagent/`, ainsi que de la documentation d'interface et des modifications d'agents ; `e13a251` ajoute des composants de tableau de bord agent.
- `6fded2a` ajoute notamment `src/lib/topics/discovery.ts`, `network.ts`, `relations.ts`, des documents de recherche et neuf fichiers de tests modifiés ou ajoutés. Les capacités réelles restent à tracer.

### 2026-11-05 au 2026-11-06 — coordination système et CI

`8763c6a` ajoute notamment `src/lib/konstruktor/`, `src/lib/system-agents/`, `src/lib/arbiter/` et `src/lib/watch/queue.ts`, ainsi que des routes et tests. Par exemple, `src/app/api/konstruktor/sessions/route.ts` à cette révision expose des handlers GET/POST déléguant à `getKonstruktor`. Il modifie 119 fichiers et constitue un repère d'évolution architecturale important ; son titre ne décrit pas l'ensemble du changement. Les garanties de persistance et de coordination restent à vérifier.

Sur la branche CI, `97d1f6c` ajoute `.github/workflows/ci.yml` le 5 novembre ; `a37f59c`, `785f4e6` et `3b2ee59` modifient les mécanismes et tests d'arrêt serveur/flux ; le dernier ajoute `src/instrumentation.ts` et `src/lib/server/shutdown.ts` et remplace un fichier de test d'arrêt. D'autres commits ajustent diagnostics et tests navigateur. Le merge `4d333e4` a pour parents `8763c6a` et `e0ff51f` ; il intègre cette lignée dans la référence le 6 novembre. Son message mentionne la PR #1 ; ses métadonnées et contrôles historiques sont précisés dans la consolidation H2. Les noms des commits de correction et la présence de tests ne démontrent pas que la CI ou les parcours réussissent.

## Branches connues et divergences

Comptages `git rev-list --left-right --count main...<ref>` : commits atteignables uniquement depuis `main`, puis uniquement depuis la référence. Ces chiffres ne comparent pas directement les comportements ; les références distantes sont celles connues localement.

| Référence | Pointe | Main seul / branche seule | Constat local |
| --- | --- | --- | --- |
| `main` | `4d333e4` | 0 / 0 | Référence auditée. |
| `origin/main` | `4d333e4` | 0 / 0 | Identique localement ; pas d'actualisation distante. |
| `origin/ci/github-actions` | `e0ff51f` | 1 / 0 | Ancêtre direct côté second parent du merge ; commits de branche intégrés par ascendance. |
| `clean/github-actions` | `c2cfea7` | 13 / 0 | Ancêtre de `main` ; CI initiale, avant correctifs ultérieurs. |
| `clean/main` | `8763c6a` | 18 / 0 | Ancêtre de `main` ; avant intégration CI. |
| `clean/password-reset` | `f971712` | 18 / 4 | Quatre commits propres à la branche, après l'ancêtre commun `8763c6a`. |
| `feat/password-reset` | `f971712` | 18 / 4 | Exactement la même pointe que `clean/password-reset`. |
| `backup/ci-before-rewrite` | `cb3e8d4` | 33 / 20 | Ancêtre commun `7b9ebad` ; histoire parallèle en grande partie équivalente par patch, pas intégrée par ascendance. |

Sur les deux branches password-reset, `f1e1825` ajoute une commande interactive locale (`scripts/reset-password.ts`, `src/lib/password-reset.ts`), `155e8c7` ajoute des tests, `c6e5ece` la documentation et `f971712` un dialogue d'instructions sur la page de connexion et un test navigateur. `git diff --name-status main...clean/password-reset` indique neuf fichiers changés, dont ces fichiers ajoutés. Ces commits ne sont pas ancêtres de `main` et `git log --right-only --cherry-pick main...clean/password-reset` les conserve tous. Leur fonctionnalité n'est pas intégrée **sous cette forme historique** ; une recherche ciblée H2 n'a trouvé aucun équivalent Xi explicite sur `main`, sans exclure les capacités natives ou indirectes ; voir la consolidation. Aucun test exécuté.

Pour `backup/ci-before-rewrite`, `git log --left-right --cherry-mark main...backup/ci-before-rewrite` marque comme équivalents par patch la plupart des commits d'évolution d'octobre et les cinq premiers commits CI ; les deux commits anciens `ccac3f1` et `18285da` restent propres à la lignée et leurs arbres doivent être interprétés en tenant compte des artefacts générés. Le diff des pointes `git diff --name-status main backup/ci-before-rewrite` montre surtout des ajouts ultérieurs sur `main` concernant arrêt serveur, diagnostics et tests/CI. L'équivalence de patch ne prouve pas une équivalence fonctionnelle complète ni l'intégration par ascendance.

## Jalons historiques candidats

- **`mvp`** : libellé explicite des commits `eeaa686` (ancêtre de `main`) et `ccac3f1` (lignée parallèle). C'est un repère nommé dans l'historique, non une preuve de milestone officielle, d'objectif contractuel, d'achèvement ou de validation.
- **Merge PR #1** : événement d'intégration Git identifiable `4d333e4`, pas une milestone nommée. La consultation H2 est détaillée ci-dessous ; aucun tag local n'a été trouvé en phase 0.

## Limites et suite

Les périodes sont des regroupements de lecture reconstruits, pas des noms officiels. Aucun test n'a été exécuté pendant H1 ou H2 ; des contrôles CI historiques ont été consultés en H2 ci-dessous. Les dates d'intégration indépendantes et les suppressions sémantiques restent ouvertes. Commandes et résultats synthétiques complémentaires : `work/checkpoints/phase-1-H1.md`.

## Consolidation H2 — sources distantes et comparaison des branches

Relevé GitHub du 6 novembre 2026 : **une PR visible**, fermée et fusionnée, **zéro ouverte**, **zéro fermée sans fusion** ; **zéro release visible**. Deux pages ont été interrogées. La seule branche distante renvoyée est `main`, au commit de référence : la référence locale `origin/ci/github-actions` est donc une trace locale d'une branche non renvoyée par la liste distante actuelle. Les dates et la raison de son retrait ne sont pas connues. L'API de liste des tags est refusée par le connecteur et celle des milestones également : leurs nombres distants restent indéterminés. Aucun tag local. Voir [preuves GitHub](work/evidence/phase-1-H2-github.md).

[PR #1](https://github.com/timoogo/xi/pull/1), ouverte le 5 novembre à 20:45:23 UTC et fusionnée le 6 novembre à 12:26:58 UTC, relie la tête `e0ff51f` à la base `8763c6a` par le merge `4d333e4`. Sa description documente le choix d'une CI avec lint, types, tests, build et navigateur, un environnement isolé et l'absence de déploiement ; elle signale Node 24 et la stabilité E2E comme points à surveiller. Pas de milestone associée, ni revue ou commentaire visible dans les listes consultées. Ces affirmations sont distinctes des résultats de jobs.

Les six jobs de la [CI de PR](https://github.com/timoogo/xi/actions/runs/42212149403) et les six jobs de la [CI post-merge](https://github.com/timoogo/xi/actions/runs/42217743143), sur le commit de référence, sont rapportés réussis par GitHub. Cela constitue une **preuve historique de réussite des jobs**, y compris lint, types, build et suites configurées ; les nombres de tests, skips internes, couverture et intégrations réelles ne sont pas établis par les métadonnées consultées. Aucun test local n'a été lancé, aucun statut fonctionnel « validée » n'en découle.

Pour les évolutions antérieures au merge, les dates de commit indiquent les dates enregistrées par Git ; leur présence dans l'ascendance de `8763c6a` montre qu'elles étaient intégrées au plus tard à la fusion de la PR, sans déterminer séparément la date de développement ou d'intégration effective. Leurs diffs H1 démontrent les changements de fichiers, non leur fonctionnement. Seule la CI précitée apporte ici une preuve historique de vérification globale ; l'état réel des comportements au commit de référence reste à tracer et qualifier aux phases suivantes.

### Réinitialisation du mot de passe : précision H2

Les quatre commits du 5 novembre ajoutent une commande administrative interactive locale, son service Better Auth, sept cas de tests déclarés, une documentation et un dialogue de connexion affichant les instructions ; le dialogue n'exécute lui-même aucune opération. Le service écrit prévoit contrôle d'identité et de longueur, hachage et révocation des sessions dans une transaction. Les tests n'ont pas été exécutés.

Une recherche ciblée dans les fichiers suivis de `main`, l'inspection de son formulaire de connexion et de sa configuration Better Auth n'ont pas trouvé d'équivalent Xi explicite de cette commande et de ce dialogue. Cela ne démontre pas l'absence d'une capacité native Better Auth ou d'une autre procédure indirecte. Le code de branche est donc **potentiellement récupérable**, sous réserve d'audit de compatibilité, de sécurité et de validation ; aucune recommandation de merge. Détails et commandes dans [preuves Git](work/evidence/phase-1-H2-git.md).

### Sauvegarde CI et jalons documentés

Les arbres `8763c6a` / `ce6b899` sont identiques, comme `c2cfea7` / `cb3e8d4`. Ce dernier point démontre que la pointe `backup/ci-before-rewrite` ne contient pas de contenu supplémentaire par rapport au point CI correspondant déjà ancêtre de `main`. Les différences avec la pointe actuelle concernent les évolutions ultérieures sur `main` ; aucun changement substantiel propre à la pointe backup n'a été trouvé.

Le nom `mvp` apparaît également dans le README historique sous l'en-tête « MVP actuel » ; c'est un périmètre documenté, pas une preuve de clôture. `docs/watch.md` mentionne explicitement des phases 3, 4 et 5 dans des descriptions de tests ; ni leur statut de milestone officielle ni leur achèvement ne sont établis. Aucun jalon historique terminé n'est certifié par H2. Les textes README décrivent des états historiques et peuvent être dépassés.
