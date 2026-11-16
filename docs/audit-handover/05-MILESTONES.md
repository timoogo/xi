# Milestones — lecture de passation

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Une milestone est terminée seulement si toutes ses capacités obligatoires ont des preuves suffisantes. Les critères ci-dessous sont proposés pour le cadrage, pas des engagements historiques. Références des 47 capacités : [inventaire](03-FEATURE-INVENTORY.md) et [preuves](06-VALIDATION-EVIDENCE.md).

## Jalons historiques explicitement identifiables

- **H-MVP — « mvp »** : commit `eeaa686`, libellé également dans le README historique ; ajout d'auth, publications et graphe, voir [chronologie](04-HISTORICAL-TIMELINE.md). Aucun critère historique de clôture ni validation complète établi ; **repère historique, achèvement non déterminable**, pas milestone terminée certifiée. **Périmètre historique** : auth, publications et graphe ajoutés au moins dans le diff ; correspondance actuelle F1-AUTH-01–02, F2-07, F3-07. **Dépendances** : Next, Better Auth, SQLite et vault. **Critères satisfaits** : intégration Git démontrée ; scénarios ciblés testés plus tard. **Critères manquants / blocages** : critères d’origine inconnus, complétude et acceptation du MVP non démontrées.
- La PR #1 intègre la CI via `4d333e4` ; c'est un événement d'intégration documenté, pas un jalon officiellement nommé. Les phases mentionnées dans `docs/watch.md` ne suffisent pas à établir des milestones officielles. Aucune autre milestone historique officielle ni terminée n'est démontrée ; API des milestones GitHub non accessible lors de H2.

## Regroupements fonctionnels reconstruits

### M1 — Identités et accès

- **Historique / état réel** : socle `eeaa686`, puis comptes et avatars étendus dans `b3690b7`, `c05ad4a` ; code présent sur main, reset distinct sur branche expérimentale. **Blocages** : décision sur récupération, garanties de droits et parcours complet.

- **Objectif/périmètre** : inscription, session, profils et avatars ; F1-AUTH-01–03, F1-USER-01–02, F1-AVATAR-01–03.
- **Dépendances** : Better Auth, SQLite, vault, permissions. **Preuves** : tests auth et navigateur historiques, tests avatars locaux ; matrice fonctionnelle. La récupération locale est sur une branche expérimentale.
- **Critères proposés** : parcours inscription/session/déconnexion et autorisations acceptés ; décision et chemin de récupération de compte sûrs ; gestion des profils et avatars éprouvée avec données jetables.
- **Validé / non validé** : scénarios ciblés réussis ; capacité globale et récupération non validées. **État : NON TERMINÉE**.

### M2 — Topics, recherche et connaissances

- **Historique / état réel** : `b3690b7` puis `6fded2a` introduisent et étendent les Topics et la découverte ; code présent sur main. **Blocages** : critères produit de connaissance, preuve de découverte réelle et confidentialité complète.

- **Périmètre** : F2-01–07 ; création, relations, recherche, graphe, connaissances et découverte. **Dépendances** : identité, index SQLite/vault, modèles pour découverte.
- **Preuves** : tests topics, recherche, graphe et navigateurs CI, ainsi que tests locaux de visibilité et provenance. **Critères** : parcours partagés/personnels et confidentialité, reconstruction et qualité de découverte explicitement acceptés.
- **Validé / non validé** : scénarios ciblés réussis, découverte réelle et garanties de reprise non établies. **État : NON TERMINÉE**.

### M3 — Publications et échanges

- **Historique / état réel** : socle `eeaa686`, flux/conversations `9deac59` et `b781dd4`, changements d’arrêt en `3b2ee59` ; code intégré. **Blocages** : TypeError non expliqué et décisions sur notifications.

- **Périmètre** : F3-07–09, F5-06, F1-UI-01–02 ; publications, conversations, fil, navigation et réconciliation. **Dépendances** : comptes, vault, permissions, SSE.
- **Preuves** : tests de publications, conversations, fil, navigation navigateur CI ; TypeError de réconciliation à diagnostiquer. **Critères** : parcours et droits convenus, reprises, correction de l'anomalie si confirmée ; décision produit sur notifications et communautés.
- **Validé / non validé** : cas de stockage et navigateur réussis ; périmètre complet et notifications non démontrés. **État : NON TERMINÉE**.

### M4 — Sources et production éditoriale

- **Historique / état réel** : `e173294` introduit le worker de veille ; `50d6475` et `8763c6a` l’étendent. Code intégré, tests surtout simulés. **Blocages** : accès de test à un modèle et à une source explicitement autorisée, règles de diffusion.

- **Périmètre** : F3-01–06 ; sources, confiance, collecte, analyse, brouillons, diffusion. **Dépendances** : agents, modèles, worker, politiques et permissions de publication.
- **Preuves** : `tests/integration-pipeline.test.ts` avec réponses simulées, tests `watch` et navigateur CI, V3 local. **Critères** : parcours contrôlé source réelle vers brouillon, provenance, vérification éditoriale et règles de diffusion sur fixtures, traitement des indisponibilités.
- **Validé / non validé** : scénarios simulés réussis ; intégrations réelles et publication complète non démontrées. **État : NON TERMINÉE**.

### M5 — ΞAgents, Konstruktor et Arbitre

- **Historique / état réel** : transitions agents `d70a31c`/`50d6475`, composants système `8763c6a`. Code intégré et déploiement distinct de la validation. **Blocages** : correspondance exhaustive des champs et vérification des autorisations.

- **Périmètre** : F1-ACCOUNT-01–02, F4-01–10 ; configuration, import, déploiement, orchestration de propositions et arbitrage. **Dépendances** : M1, M2, M4, modèles et persistance.
- **Preuves** : tests agents, déploiement, Konstruktor et Arbitre local/CI et scénarios navigateur historiques. **Critères** : configuration et validation humaine conformes, champs sélectionnés tracés, reprise sans effet indésirable, contrôle des rôles ; arbitrage et publication demeurent distincts.
- **Validé / non validé** : scénarios simulés de reprise réussis ; intégrations réelles et périmètre complet non établis. **État : NON TERMINÉE**.

### M6 — Inférence et exploitation fiable

- **Historique / état réel** : worker `e173294`, connecteurs LLM `4bdf533`, coordination `8763c6a`. Code présent ; exploitation réelle inconnue. **Blocages** : environnement et procédure du worker, modèle local et essais de panne sur fixtures.

- **Périmètre** : F5-01–05 et F5-07 ; modèles, file, tâches, worker, migrations. **Dépendances** : configuration de déploiement, SQLite/vault, services locaux.
- **Preuves** : tests de file et migrations sur copie en CI, modèles factices, lint/typecheck/build CI. **Critères** : vérification avec modèle local, exploitation du worker hors dev, interruption/reprise et sauvegarde-restauration sur fixtures.
- **Validé / non validé** : tests de scénarios isolés réussis ; environnement d'exploitation réel et effets après interruption non démontrés. **État : NON TERMINÉE**.

### M7 — Expérimentations produit

- **Historique / état réel** : prototype `a821710` autonome ; vision visuelle issue de la mission, pas de moteur identifié dans la recherche ciblée. **Blocages** : arbitrage produit et matériel ; aucune exigence d’implémentation ne doit être supposée.

- **Périmètre** : F6-01 prototype, F6-02 génération visuelle. **Dépendances** : arbitrage produit et capacités locales choisies.
- **Preuves** : prototype autonome avec données fictives ; recherche ciblée sans moteur visuel identifié. **Critères** : décider du devenir du prototype et, si retenue, définir expérience, modèles et contraintes visuelles.
- **Validé / non validé** : aucune capacité obligatoire finalisée ; prototype expérimental, génération visuelle planifiée. **État : NON TERMINÉE**.

Ces sept regroupements sont candidats à la structuration future ; ils ne sont pas des milestones historiques ni des objets Linear existants. Les critères ne constituent pas une liste de tâches imposées.
