# Présentation des publications

Référence inspectée : ../ui-redesign-post-component/app/page.tsx.
Le chemin fourni ../xi-v0-reference n’existait pas dans cet environnement.
Seule l’intention visuelle de cette maquette est reprise ; aucun compteur,
label de démonstration ou état social fictif n’est importé.

## Composants

- PublicationCard / PublicationContent : fond sombre local, avatar de 40 px,
  noms et handles distincts, Markdown aligné, connecteurs entre messages,
  une barre répondre/partager par publication. La colonne du dashboard reste
  à sa largeur existante de 640 px.
- ConversationView : même anatomie pour les auteurs de chaque réponse.
  L’état, les curseurs, ancres, SSE et la restauration du scroll sont conservés.
- MessageMenu : Modifier (ou Créer une correction pour une analyse immuable)
  et Supprimer pour l’auteur uniquement. Les composants existants assurent
  toujours confirmation, corbeille privée, annulation et autorisation serveur.
- UserAvatar / BloubAvatar : image de compte prioritaire ; Bloub par défaut
  lorsque authorType vaut ai, avatar humain inchangé.
- MarkdownImage : image HTTPS chargée au clic uniquement, sans referrer.
  Le cadre 16:9 est réservé avant chargement ; l’image reste entière.
  Une erreur propose de réessayer. Aucun HTML brut ou iframe n’est activé.
- globals.css : palette et focus limités aux publications, sans refonte
  de la navigation, des topics, des comptes ou du dashboard.

## Invariants et limites

Le tri conversationnel et la limite de trois messages principaux restent
pilotés par conversationTree. Aucune réponse secondaire n’est ouverte dans
le feed, même pour un parent supprimé. Les détails conservent les réponses.
Les identités immuables des messages et les liens permanents sont conservés.

Le contrat actuel attribue un auteur à une publication entière. Les auteurs
distincts sont rendus à partir des données de chaque publication dans les
conversations ; aucun auteur par message n’est inventé dans un thread.
Les handles hiérarchiques viennent toujours de getFeedAuthors.

Bloub réutilise uniquement le regard et le clignement au repos du projet MIT,
pas ses quatorze animations de démonstration. Voir src/lib/bloub/README.md et
LICENSE pour la provenance. Le SVG initial est statique ; le code d’animation
est importé à la première intersection visible, uniquement sans réduction
des mouvements et dans un onglet visible. Les changements de préférence
arrêtent immédiatement la boucle. Sans IntersectionObserver ou en cas
d’échec de chargement, la pose statique reste disponible.

Les assets du vault ne sont pas servis par le système actuel. Les vidéos et
les aperçus enrichis de liens n’ont pas de contrat existant : les liens
restent des liens Markdown, sans requêtes de métadonnées ni embeds tiers.
Aucune API, aucun schéma SQLite ni format de fichier n’est changé.

## Vérification

Le test publication-design-browser.test.ts utilise le build de production
et un vault temporaire : posts de un à quatre messages, aperçu de trois,
connexions mesurées, mobile 390 px sans débordement, image au clic sans
décalage, réduction des animations et arrêt hors écran. Captures dans
/tmp/xi-publications-desktop.png et /tmp/xi-publications-mobile.png.

Les parcours e2e existants couvrent les menus autorisés/interdits, suppression,
restauration, Markdown, visibilité privée, modifications, réponses, ancres,
scroll et SSE. Leurs sélecteurs de suppression suivent maintenant le menu.

Résultats : build de production, TypeScript et ESLint validés. Toutes les
suites existantes ont été exécutées (117 tests hors navigateur, 10 tests
navigateur existants), avec relance ciblée réussie des régressions
d’authentification et de suppression après correction. Le test navigateur
de design supplémentaire passe également. Les captures desktop/mobile
ont été inspectées visuellement.

Dans cet environnement, les commandes utilisent directement
`node --import tsx` avec `TSX_TSCONFIG_PATH=tests/tsconfig.json` ;
`NODE_PATH=node_modules/.pnpm/node_modules` permet à ESLint de résoudre
ses plugins déjà installés. Les tests HTTP/Chrome et le build ont été
exécutés hors des restrictions de sockets du bac à sable. Aucun changement
de dépendances ou de configuration de projet n’a été nécessaire.
