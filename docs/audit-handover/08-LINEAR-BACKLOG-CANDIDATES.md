# Candidats de backlog pour Linear

Propositions pour discussion avec le Scrum Master et le responsable produit. Aucun objet n'a été créé dans [le projet Xi](https://linear.app/timogo/project/xi-a8e00a26feb3). Priorités proposées : P1 à traiter d’abord, P2 ensuite selon usage, P3 après décision produit ; elles restent à arbitrer, sans estimation ni date ; consulter [risques](07-TECHNICAL-DEBT-AND-RISKS.md), [milestones](05-MILESTONES.md) et [preuves](06-VALIDATION-EVIDENCE.md).

## 1. Fonctionnalités partielles à terminer

### B1 — Cadrer notifications et communautés

- **Priorité proposée** : P2 — cadrage produit.

- **Problème / état** : écrans partiels, texte communautés contradictoire avec suivi existant ; F1-UI-02, F3-09.
- **Résultat attendu** : contenu cohérent avec les fonctions et décision explicite sur notifications et communautés.
- **Dépendances / preuves** : préférences sociales et produit ; inventaire F1-UI-02, R10.
- **Critères proposés** : scénarios retenus décrits, liens et libellés cohérents, notifications démontrées seulement si retenues. **Questions** : quels événements et destinataires ?

### B2 — Récupération de compte

- **Priorité proposée** : P2 — accès et récupération.

- **Problème / état** : commande et interface sur branches `clean/password-reset` et `feat/password-reset`, non intégrées à main ; F1-AUTH-03.
- **Résultat attendu** : procédure choisie et sûre, éventuellement à partir du travail existant.
- **Dépendances / preuves** : Better Auth, sécurité locale, audit de compatibilité ; chronologie H2 et diffs des quatre commits.
- **Critères proposés** : procédure documentée, contrôle d'identité et révocation des sessions vérifiés en environnement jetable. **Question** : qui est autorisé à récupérer un compte ? Aucun merge recommandé à ce stade.

## 2. Défauts démontrés à corriger

### B3 — Corriger la formulation des migrations et les textes de suivi

- **Priorité proposée** : P2 — documentation contradictoire.

- **Problème / état** : commentaire « additive » incompatible littéralement avec les reconstructions ; indication de suivi obsolète. R4, R10.
- **Résultat attendu** : documentation et interface reflètent les comportements effectifs.
- **Dépendances / preuves** : `src/lib/maintenance/migration-check.ts:31`, `src/lib/watch/evaluate.ts:58`, écran communautés et contrôles profil.
- **Critères proposés** : décrire explicitement reconstructions/transactions et parcours de suivi ; révision par responsable technique et produit. **Question** : quelles versions de migration doivent rester prises en charge ?

## 3. Fiabilisation technique

### B4 — Diagnostiquer la réconciliation des publications

- **Priorité proposée** : P1 — anomalie à diagnostiquer.

- **Problème / état** : TypeError observé en local et CI, cause indéterminée ; R1.
- **Résultat attendu** : origine comprise et, si défaut, correction avec preuve de non-régression.
- **Dépendances / preuves** : watcher, HMR et index ; logs V3 et CI agents, `src/lib/publications/runtime.ts:20–25`.
- **Critères proposés** : reproduction isolée ou hypothèses réduites par traces sûres, index et réconciliation vérifiés après événement. **Question** : l'erreur est-elle liée à la fixture ou au runtime ?

### B5 — Reprise des tâches et cohérence des supports

- **Priorité proposée** : P1 — intégrité et reprise.

- **Problème / état** : `Promise.race` n'annule pas un handler ; absence de transaction globale vault/SQLite. Des protections et tests de reprise existent ; R2–R3.
- **Résultat attendu** : garanties explicites et vérifiables face aux coupures et doublons.
- **Dépendances / preuves** : worker, queue, index, sauvegarde ; contrats A2 et tests V3/CI.
- **Critères proposés** : scénarios perte de bail, coupure entre supports, redémarrage et restauration sur copie ; effets observés conformes au contrat retenu. **Question** : quels effets exigent une déduplication forte ?

### B6 — Autorisations et validation des configurations agents

- **Priorité proposée** : P1 — autorisations et validation humaine.

- **Problème / état** : contrôles serveur présents ; helper du registre non appelé, correspondance champs/choix Konstruktor incomplètement établie. R6–R7.
- **Résultat attendu** : contrats de sécurité et de validation vérifiables à chaque frontière.
- **Dépendances / preuves** : tâches système, stores, déploiements, proposition/validation ; A2 et F4-07.
- **Critères proposés** : matrice acteur/action, cas de refus HTTP et tâches, preuve que chaque champ appliqué est autorisé et validé. **Question** : quelle sémantique attribuer aux permissions du registre ?

### B7 — Mode opératoire de la veille et CI

- **Priorité proposée** : P1 — exploitation et publication.

- **Problème / état** : worker dépend d'un processus actif ; publication privée dev possible sous conditions ; navigateur non exigé par le ruleset observé. R5, R8, R9.
- **Résultat attendu** : exploitation locale prévisible et politique d'intégration connue.
- **Dépendances / preuves** : scripts worker, règles GitHub, calendrier et autorisations.
- **Critères proposés** : procédure dev/prod, état du worker observable, récupération documentée, décision motivée sur caractère obligatoire d'E2E. **Questions** : qui exploite le worker ? quelles exceptions au ruleset ?

### B8 — Vérifier les intégrations réelles à risque

- **Priorité proposée** : P1 — parcours réel à caractériser.

- **Problème / état** : tests existants couvrent transports simulés, pas un modèle et des sources réels de bout en bout.
- **Résultat attendu** : parcours source autorisée → analyse → brouillon en environnement jetable ; politique de diffusion séparée.
- **Dépendances / preuves** : Ollama, source autorisée, vault/base de test ; F3-03–06, F5-02 et `tests/integration-pipeline.test.ts`.
- **Critères proposés** : modèle local réellement interrogé, provenance conservée, indisponibilité traitée, aucune publication non autorisée. **Question** : quelles sources et quel modèle sont représentatifs ?

## 4. Fonctionnalités futures documentées

### B9 — Génération locale de représentations visuelles

- **Priorité proposée** : P3 — décision future.

- **Problème / état** : vision fournie par la mission, sans implémentation identifiée après recherche ciblée ; F6-02.
- **Résultat attendu** : décision produit et spécification avant implementation.
- **Dépendances / preuves** : ressources locales, droits d'usage, publication ; inventaire F6-02.
- **Critères proposés** : usage, qualité et contraintes matérielles définis ; prototype évalué si décision favorable. **Question** : quelles représentations et sur quel matériel ?

## 5. Expérimentations et décisions produit

### B10 — Décider du devenir du prototype ΞAgent

- **Priorité proposée** : P3 — décision UX.

- **Problème / état** : prototype autonome avec données fictives ; fonctionnalités analogues peuvent exister dans le produit. F6-01.
- **Résultat attendu** : décider de son rôle comme référence UX, expérimentation ou archive.
- **Dépendances / preuves** : comparaison des parcours produit ; `prototypes/v0-xiagent`, inventaire F6-01.
- **Critères proposés** : décision documentée et critères de réutilisation UX. **Question** : quels parcours du prototype ont une valeur produit non encore couverte ?
