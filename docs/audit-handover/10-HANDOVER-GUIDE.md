# Guide de prise en main pour le Scrum Master

Ce dossier décrit Xi au commit `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Il aide à préparer le travail avec le responsable produit et l'équipe technique ; il ne vaut pas acceptation produit ni certification de toutes les fonctions.

1. Lire [01 — Vue produit](01-PRODUCT-OVERVIEW.md), puis [05 — Milestones](05-MILESTONES.md). Le jalon historique « mvp » est un repère ; les sept autres sont des regroupements proposés pour faciliter la discussion, sans objet Linear créé. Aucun n'est déclaré terminé.
2. Consulter [03 — Inventaire](03-FEATURE-INVENTORY.md) pour chaque capacité, son code, ses limites et son statut. « Implémentée, non validée » signifie que du code et parfois des scénarios testés existent, mais que toutes les garanties de la capacité entière ne sont pas démontrées. Ne pas compter une branche expérimentale comme une livraison de `main`.
3. Consulter [06 — Validation](06-VALIDATION-EVIDENCE.md) : 329 tests locaux réussis sur 57 fichiers ; sur le commit, CI historique avec 431 cas réussis dans les suites configurées et build réussi. Ces résultats se recoupent et ne s'additionnent pas pour compter des fonctionnalités. Mocks, serveur Next et navigateur sont distingués des intégrations réelles à des services externes.
4. Lire [07 — Risques](07-TECHNICAL-DEBT-AND-RISKS.md) et [09 — Questions](09-OPEN-QUESTIONS.md). Le TypeError de réconciliation est observé mais non expliqué ; les risques d'effets après perte de bail et de désynchronisation doivent être vérifiés, aucune perte durable n'est constatée.
5. Utiliser [08 — Candidats Linear](08-LINEAR-BACKLOG-CANDIDATES.md) en atelier : confirmer d'abord les objectifs et critères, regrouper les sujets par capacité, puis seulement créer les objets pertinents. Rien n'a été créé dans Linear et aucune date ni estimation n'est imposée.

## Premières séances suggérées

- Avec le responsable produit : définir utilisateur, scénarios prioritaires, attentes sur mentions, notifications, autonomie et qualité éditoriale ; choisir les critères de chaque regroupement.
- Avec l'équipe technique : revoir frontières d'autorisation, garanties de reprise, sauvegardes, état du worker, TypeError, intégration réelle à un modèle et à une source autorisée.
- Avec la personne responsable du dépôt : confirmer les règles de `main`, leur portée et les exceptions ; cinq jobs sont exigés par le ruleset observé, le navigateur n'en fait pas partie.
- Revoir le backlog proposé, ses dépendances et les questions encore ouvertes ; éviter de recréer Konstruktor ou l'Arbitre sous un autre nom.

## Vérifier les preuves et reprendre l'audit

Les chemins de code dans l'inventaire et [02 — Architecture](02-ARCHITECTURE.md), les commits de [04 — Historique](04-HISTORICAL-TIMELINE.md), les journaux de `work/logs/` et les matrices de `work/evidence/` permettent de remonter aux faits. Les résultats CI sont historiques et les données réelles de l'utilisateur ne sont pas auditées. Vérifier `git rev-parse HEAD` et l'état Git avant toute reprise ; si le commit change, séparer les versions et demander une décision. [00 — État](00-AUDIT-STATE.md) et les checkpoints sont la source de vérité de l'avancement.

V4 est conservé comme dispositif préparé, non exécuté et non requis automatiquement. Tout essai complémentaire doit être décidé selon la lacune démontrée, avec base et vault jetables et sans publication réelle.
