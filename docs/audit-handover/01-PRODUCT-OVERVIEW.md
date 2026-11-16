# Xi — vue produit pour la passation

Xi est une application locale de veille, recherche, capitalisation des connaissances et publication collaborative, organisée autour de Topics et d'agents spécialisés appelés ΞAgents. Cette formulation décrit l'ambition ; les garanties effectives dépendent des parcours et des décisions ci-dessous. Référence auditée : `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`.

## Existant identifié et scénarios vérifiés

- **Identités et accès** : Better Auth et SQLite portent des comptes humains ; l'interface et le serveur gèrent inscription, connexion et session. Des agents éditoriaux ont une identité et des paramètres. Tests de serveur et navigateur en CI ; portée complète et procédure de récupération restent à qualifier.
- **Topics, recherche et graphe** : création et organisation de Topics, relations, recherche croisée et projections de graphe sont présentes. Les tests de confidentialité, recherche et reconstruction ont des résultats locaux et CI. Une relation affichée n'établit pas à elle seule la vérité d'un fait.
- **Veille et sources** : catalogue, collecte, évaluation, provenance, rédaction de brouillons et diffusion sont reliés dans le code. Les tests de chaîne utilisent des modèles et flux simulés ; une veille réelle complète n'a pas été démontrée pendant l'audit.
- **Publications et échanges** : brouillons, publications, conversations, réponses, abonnements, fil et liens `@handle` sont présents ; stockage dans le vault et index SQLite. Un lien mention ne démontre ni notification ni déclenchement automatique d'un agent.
- **Agents système** : Konstruktor permet d'élaborer et faire valider des propositions ; un déploiement distinct applique les changements. L'Arbitre traite des demandes internes de priorité ; le diffuseur garde la décision de publication et ses contrôles. Le système comporte déjà ces composants : aucun nouvel orchestrateur ne doit être supposé nécessaire.
- **Local-first** : l'application utilise un vault de fichiers, SQLite et des connecteurs d'inférence locale ou compatible. Cela ne garantit pas que tout traitement est hors ligne : collecte et modèles peuvent utiliser le réseau selon configuration. Les tests du connecteur utilisent des serveurs factices.

Les scénarios de tests réussis et leurs limites sont dans [06 — Validation](06-VALIDATION-EVIDENCE.md). Une capacité implémentée n'est pas automatiquement qualifiée « validée » pour tout son périmètre.

## Partiel ou expérimental

Les écrans notifications et communautés sont partiels ; une indication sur le suivi est contradictoire avec des contrôles existants. La récupération locale de mot de passe existe sur une branche non intégrée ; elle n'est pas démontrée sur `main`. Un prototype ΞAgent autonome utilise des données fictives. Un TypeError de réconciliation est visible dans des journaux de test, mais sa cause et son impact sont indéterminés.

## Vision et décisions à prendre

La génération locale de représentations visuelles appartient à la vision fournie ; aucune implémentation pertinente n'a été identifiée lors de la recherche ciblée. La profondeur de mémoire collective, les notifications, les engagements d'exploitation du worker et les conditions de diffusion autonome doivent être précisés avec le responsable produit. Les sept regroupements de [05 — Milestones](05-MILESTONES.md) sont des outils de cadrage reconstruits, pas des jalons officiels historiques.
