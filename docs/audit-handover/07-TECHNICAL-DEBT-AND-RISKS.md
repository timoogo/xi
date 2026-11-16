# Dette technique et risques

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Gravité proposée pour discussion, sans probabilité quantifiée ; confiance porte sur le constat, pas sur la matérialisation d'un incident. Les tests réussis et les mécanismes de protection existants sont précisés dans [validation](06-VALIDATION-EVIDENCE.md) et [contrats A2](work/evidence/phase-2-A2-contracts.md).

## Ordre de traitement proposé

- **P1** : R1, R2, R3, R5, R7 et R8 — diagnostic, intégrité, publication et exploitation.
- **P2** : R4, R6, R9 et R10 — contrats, documentation et gouvernance ; R6 peut devenir P1 si un chemin sans contrôle est démontré.

Priorité de cadrage, distincte de la gravité et de la certitude ; ne préjuge pas de la probabilité d’incident.

### R1 — TypeError de réconciliation

- **Constat** : message d'erreur dans V3 local et job CI agents, `src/lib/publications/runtime.ts:20–25` ne journalise que le type. Scénarios concernés passent ; origine et impact indéterminés.
- **Impact potentiel / gravité** : réconciliation ou visibilité d'une erreur difficile à diagnostiquer, élevé si données manquées, impact réel inconnu. **Certitude** : élevée sur journal, faible sur cause et impact.
- **Piste** : reproduire sur copie jetable avec pile sans contenu sensible, isoler watcher/HMR et vérifier l'état de l'index. Ne pas qualifier de défaut confirmé avant reproduction.

### R2 — Interruptions, baux et effets de handlers

- **Constat** : `src/lib/watch/worker.ts:76–91,125` utilise `Promise.race` et le handler n'est pas annulé par ce mécanisme ; `jobs.ts:139` protège les transitions par jeton. **Risque** : un travail déjà lancé peut continuer après expiration ou arrêt ; un effet indésirable n'est pas démontré.
- **Impact / gravité** : doublon ou écriture tardive possible selon handler ; élevé. **Certitude** : élevée sur sémantique du mécanisme, moyenne sur conséquences.
- **Piste** : scénario isolé avec handler bloqué, perte de bail et reprise ; définir idempotence et annulation aux frontières d'effets.

### R3 — Cohérence vault / SQLite

- **Constat** : fichiers atomiques individuellement et réconciliation existent, aucune transaction globale démontrée (`work/evidence/phase-2-A2-contracts.md`, section cohérence). Tests de reconstruction et migrations sur copies réussis ; aucune perte durable constatée.
- **Impact / gravité** : interruption entre supports peut créer un état intermédiaire ; élevé, probabilité inconnue. **Certitude** : élevée sur absence de transaction globale identifiée, moyenne sur effets.
- **Piste** : tester coupures aux points d'écriture, reprise, sauvegarde/restauration et écarts d'index sur copies.

### R4 — Migrations : documentation et garanties

- **Constat** : `src/lib/maintenance/migration-check.ts:31` décrit des étapes additives ; `src/lib/watch/evaluate.ts:58` reconstruit une table et `src/lib/publications/index-db.ts:22` supprime des tables d'index dérivées. Des transactions et reconstructions existent ; le test de migration sur copie a réussi en CI.
- **Impact / gravité** : formulation trop large, risque de mauvaise préparation d'une migration ; moyen. **Certitude** : élevée sur contradiction, absence de perte de données non démontrée pour toutes les versions.
- **Piste** : documenter les opérations et versions, sauvegardes, reprise et rollback, compléter les scénarios significatifs sur copies.

### R5 — Publication automatique en développement

- **Constat** : le worker dev force l'autorisation opérateur de publication privée mais pas publique ; activation dépend encore de la politique, du mode autonome, de l'agent, des candidats et des garde-fous éditoriaux/calendrier (`work/evidence/phase-2-A2-contracts.md`).
- **Impact / gravité** : publication privée non anticipée si développement lancé sur données réelles et conditions réunies ; élevé. **Certitude** : élevée sur conditions statiques, incident non observé.
- **Piste** : rendre le mode et ses effets visibles, définir procédure de développement sur vault jetable et tester explicitement les règles.

### R6 — Frontières d'autorisation des agents système

- **Constat** : le registre déclare des permissions mais recherche ciblée ne trouve aucun appel à `hasPermission` ; les protections observées existent dans tâches/stores et contrôles de propriétaire (`src/lib/system-agents/registry.ts:15`, `store.ts:115`).
- **Impact / gravité** : risque de supposer qu'une déclaration seule bloque une action ; moyen à élevé. **Certitude** : élevée sur absence d'appel trouvé, faille non démontrée.
- **Piste** : cartographier chaque frontière effective, vérifier les chemins HTTP et tâches et préciser le contrat du registre.

### R7 — Configuration validée par Konstruktor

- **Constat** : propositions, validation et déploiement séparé existent (`src/lib/konstruktor/service.ts:153–176`) ; correspondance complète entre choix retenus et tous les champs soumis reste ouverte.
- **Impact / gravité** : application d'un champ non compris dans la validation si une lacune existe ; élevé par précaution, défaut non prouvé. **Certitude** : moyenne.
- **Piste** : tracer chaque champ et les tests de refus, cible, révision et validation humaine ; vérifier les cas non couverts en fixtures.

### R8 — Observabilité et exploitation du worker

- **Constat** : scripts de worker et exemple de timer existent, installation réelle non établie (`scripts/watch-dev.ts`, `scripts/watch-worker.ts`, `docs/watch.md:737`). Absence de processus actif peut différer la reprise.
- **Impact / gravité** : veille et file en attente malgré interface disponible ; moyen à élevé selon usage. **Certitude** : élevée sur dépendance au processus, exploitation réelle inconnue.
- **Piste** : décision d'exploitation, indicateurs d'état, procédure de démarrage/arrêt et reprise sur environnement isolé.

### R9 — Protections CI et limites de couverture

- **Constat** : ruleset actif exige cinq jobs ; E2E navigateur non obligatoire. Protections classiques et règles héritées inaccessibles ; aucun défaut de configuration globale affirmé. Tests simulés et réussite du build ne prouvent pas Ollama ou sources réelles.
- **Impact / gravité** : intégration possible malgré échec navigateur ou lacune de parcours selon politique applicable ; moyen. **Certitude** : élevée sur ruleset observé, limitée pour autres règles.
- **Piste** : responsable dépôt confirme politique, contournements, stabilité E2E et critères pour le rendre obligatoire.

### R10 — Contradictions de documentation produit

- **Constat** : écran communautés indique que le suivi n'est pas disponible alors que les contrôles de suivi existent (`src/app/dashboard/profiles/[id]/page.tsx:22`, inventaire F3-09). Notifications restent à cadrer.
- **Impact / gravité** : expérience et compréhension trompeuses ; faible à moyen. **Certitude** : élevée sur textes et code ciblés, parcours complet à vérifier.
- **Piste** : revoir textes et périmètre produit avec les utilisateurs.
