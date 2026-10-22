# Contrat du fil et des conversations

Ce document décrit le périmètre de stabilisation du fil existant. Il remplace les descriptions historiques de « fil vide » et d'actions désactivées du MVP initial. Il n'annonce ni moteur de veille IA, ni communautés, ni nouvelles interactions sociales.

## Données et accès

- Les publications, sources, abonnements et préférences restent des fichiers Markdown du vault.
- SQLite est un index reconstructible. Les corps ne sont pas stockés dans un cache navigateur persistant.
- Un brouillon est privé. Une publication publiée est lisible par son auteur, par les membres si elle est publique, ou par les abonnés si sa visibilité est `followers`.
- Le retrait d'un abonnement révoque l'accès aux publications `followers`. Une publication publique reste accessible directement, mais quitte le fil « Abonnements ».
- Masquer un compte filtre les deux fils, mais ne révoque pas l’accès direct à ses publications ni leurs mises à jour SSE.
- Les relations du graphe sont filtrées par les permissions de leurs deux extrémités.
- Les mutations de préférences doivent provenir de l'origine `BETTER_AUTH_URL`, pas de l'adresse interne utilisée par Next.js.

## Classement et pagination

« Abonnements » est strictement chronologique, du plus récent au plus ancien. Les descendants d'un générateur suivi sont inclus. Un compte explicitement masqué est exclu des deux fils.

« Pour vous » respecte les niveaux Prioritaire, Normal et Moins, dans cet ordre. Dans chaque niveau, il prend une publication par auteur à chaque tour. Le score éditorial, la date puis l'UUID départagent les publications d'un auteur et les auteurs d'un même tour. Les préférences priment sur la diversité : un seul auteur prioritaire peut donc précéder tous les auteurs normaux. Aucun historique de navigation ne sert au classement.

Les pages contiennent au plus vingt publications. Le curseur associe le dernier UUID à une empreinte de l'ordre du fil autorisé. Si cet ordre change, l'API répond 409 et le client recommence depuis la première page. L'empreinte ne repose pas sur l'activité privée globale.

Le client reconstruit une portion continue jusqu'aux publications déjà chargées. Il n'associe jamais un nouveau début de fil à un ancien curseur. Les nouveautés attendent le bouton « Nouvelles publications » ; les modifications et retraits sont appliqués immédiatement. « Afficher plus » est une action explicite qui intègre également les nouveautés en attente. Une réponse réseau obsolète ne remplace pas une lecture plus récente. En cas de changements répétés pendant trois tentatives, un message propose de réessayer.

## Conversations

- L'aperçu du fil montre au plus trois messages principaux. Les branches ne consomment pas cette limite.
- Les références `<UUID>/<numéro de fichier>` sont immuables ; réordonner les messages ne change pas les liens permanents.
- Les réponses sont imbriquées sous leur parent et paginées par dix, en ordre chronologique puis par référence.
- Au-delà de deux niveaux d'imbrication, un lien ouvre la sous-conversation, avec son fil d'Ariane.
- Le retour recharge les pages précédemment consultées et restaure les branches ouvertes et le défilement. L’entrée d’historique ne conserve que les identifiants, le nombre de réponses chargées et la position ; les corps sont relus avec les permissions actuelles.
- Une modification effectuée par l'éditeur ajoute les métadonnées de date utilisées pour « Modifié ».
- Un message supprimé peut conserver un emplacement neutre si des réponses accessibles subsistent. Aucun corps ou auteur du message supprimé n'est exposé dans cet emplacement.
- Les cycles et références manquantes ne font pas disparaître les messages de l'aperçu.

## Temps réel et graphe

Une connexion SSE est partagée entre les composants montés. Elle est réconciliée à chaque reconnexion, sans dépendre d'un historique d'événements conservé en mémoire. Le serveur revérifie la session et n'émet que les changements de la projection autorisée. Le watcher du vault observe les remplacements atomiques et les modifications externes ; une réconciliation périodique couvre les événements manqués.

Les cartes publiées transmettent leurs références de messages au panneau de connexions. Ce bouton permet une consultation ; il ne prétend pas qu'une relation existe. Le panneau affiche les relations effectivement autorisées, ou un état vide.

Les handles de comptes sont comparés sans distinction de casse et avec ou sans le préfixe `@`. Une mention ambiguë ne sélectionne pas arbitrairement un compte.

## Validation

Utiliser le même build isolé pour les tests HTTP et navigateur. Ne pas lancer TypeScript pendant que Next.js supprime et recrée ses fichiers de types.

```sh
NEXT_DIST_DIR=.next-verify pnpm build
pnpm exec tsc --noEmit --incremental false
pnpm lint
pnpm test:publications
pnpm test:graph
NEXT_DIST_DIR=.next-verify pnpm test:auth
NEXT_DIST_DIR=.next-verify pnpm test:e2e
```

Les tests utilisent des bases et vaults temporaires. Chrome headless est configuré par `XI_E2E_CHROME` ou `/usr/bin/google-chrome-stable`. Les tests navigateur du fil sont dans `tests/xi-live-browser.test.ts` ; les tests du classement et de la reconstruction des pages sont dans `tests/feed.test.ts`.

### Résultat de la validation du 22 octobre 2026

- Build de production isolé `.next-verify` : réussi.
- TypeScript (`--noEmit --incremental false`), ESLint sans cache et `git diff --check` : réussis.
- Publications, rendu, conversations et synchronisation : 37 tests réussis.
- Graphe, permissions, reconstruction et performances : 50 tests réussis.
- Authentification et accès HTTP : 10 tests réussis.
- Chrome headless : 7 tests réussis, sous-tests compris ; éditeur, corbeille, restauration, conversations profondes, retour et défilement, SSE, rafale de 45 publications, reconnexion hors ligne, abonnements entre onglets, mentions et connexions autorisées.
- Total final : 104 tests réussis, aucun échec, aucun test ignoré. L'aperçu de trois messages est également vérifié par les tests de rendu.

Les fixtures navigateur écrivent le Markdown avec leur propre index SQLite en mémoire ; le serveur reste le seul écrivain de sa base. Cela vérifie réellement la prise en compte des fichiers externes, sans simuler une seconde instance Xi sur la même base. La validation navigateur porte sur Chrome, pas sur tous les moteurs de navigateur ni sur un déploiement multi-instance.

## Limites conservées

- Une instance Node unique est supposée : les verrous sont locaux au processus. La fenêtre de course avec une écriture simultanée d'Obsidian n'est pas supprimée.
- Le classement lit les métadonnées des candidats autorisés. La réconciliation du navigateur peut parcourir plusieurs pages, voire tout le fil si une ancienne entrée a disparu. C'est un compromis de simplicité pour l'application locale ; la charge du fil à très grande échelle n'est pas certifiée par les tests de performances du graphe.
- Hors ligne, un contenu déjà affiché ne peut pas être révoqué instantanément. Les permissions sont revérifiées à la reconnexion et avant de révéler les nouveautés.
- Une édition directe dans Obsidian doit renseigner `updated_at` pour afficher explicitement « Modifié » ; le corps est synchronisé indépendamment.
- Les analyses utilisent `analysis: true` et `previous_version`. Leur correction ne crée pas automatiquement de relation sémantique `updates`.
- Les médias du vault, la restauration individuelle de messages retirés, le moteur de veille IA et les interactions sociales hors périmètre restent exclus.
