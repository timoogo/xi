# Comptes éditoriaux

La page `/dashboard/accounts`, accessible dans la navigation et le menu mobile, gère les générateurs existants et les nouveaux comptes éditoriaux. Aucun modèle IA, scheduler ou mécanisme de publication n’est exécuté.

## Parcours

Sélectionnez un topic puis « Proposer un compte ». Le backend charge son scope, vérifie les handles et propose des valeurs déterministes. Choisissez un preset et une version, personnalisez le ton, la structure, la profondeur et le public visé, puis confirmez explicitement le compte, ses topics et la charte. Le compte est créé, indexé et vérifié avant que le parcours soit annoncé terminé.

L’URL conserve le UUID de l’exécution. Un rechargement retrouve la proposition enregistrée ; les modifications du formulaire non confirmées ne sont pas sauvegardées. En cas d’erreur, « Reprendre le parcours » reprend les opérations backend sans allouer un deuxième compte. Les étapes et le journal affichés viennent du backend. SSE utilise le même transport que les topics : instantanés complets, séquences, reconnexion, contrôle de session et renouvellement après 25 secondes. Il n’y a aucun travail non durable lancé en arrière-plan.

Depuis la liste, « Configurer » permet de modifier le handle, le nom, la description, les associations aux topics, la configuration, la version du preset et l’activation. Seul le propriétaire peut modifier un compte ; les comptes publics sont consultables par les utilisateurs connectés. Les générateurs historiques restent lisibles sans configuration éditoriale ; leur propriétaire peut compléter celle-ci en choisissant un topic et un preset.

## Source de vérité et compatibilité

Les comptes restent les générateurs du feed et du graphe : `generators/<handle>/index.md`, avec des dossiers physiques à plat. Le format historique `id`, `slug`, `title`, `owner_id`, `visibility`, `created_at` et le corps descriptif est conservé. Le bloc `editorial` ajoute :

- `primaryTopicId` obligatoire et `secondaryTopicIds`, références UUID de topics distincts et existants ;
- `presetId`, `presetVersion` et `settings` personnalisés ;
- `active`, `modelRef` nullable et `validationMode: human` ;
- `updatedAt`, `updatedBy` et `revision` pour le contrôle de concurrence.

L’identifiant du générateur reste immuable, y compris lors d’un changement de handle. Les propriétés YAML inconnues sont préservées. Le scope est lu depuis le topic référencé et affiché avec sa date : il n’est jamais copié dans la configuration du compte. Le bouton d’actualisation recharge le scope validé courant. Renommer un topic ne modifie pas le handle ; renommer un compte ne modifie pas le topic.

`editorial_account_index` est un index SQLite reconstructible, réconcilié depuis Markdown à chaque lecture de la liste. Il ne remplace ni l’index du graphe ni les données d’authentification. Les lecteurs historiques utilisent toujours les mêmes UUID et fichiers. Les règles historiques du feed/graphe fondées sur les préfixes de handles restent inchangées ; les associations éditoriales aux topics sont explicites et indépendantes.

Les mutations sont sérialisées entre processus sur un même hôte par le verrou SQLite existant, dans `generators/.writer-lock.sqlite`. Écritures atomiques et journal de reprise en avant `.xi-account-runs/pending.md` protègent les déplacements de handles. Après renommage, l’ancien dossier vide reste réservé, pour ne pas réattribuer implicitement un emplacement historique. Les modifications hors API doivent être effectuées hors ligne ; les révisions protègent les modifications concurrentes via API. Les fichiers invalides font échouer la réconciliation sans effacer l’index précédent. Les liens symboliques de générateurs sont refusés.

## Presets et charte

Quatre presets intégrés, version 1 : Analyste, Pédagogue, Journaliste et Historien. Ils définissent le style, sans scope ni sujet. La charte commune impose transparence, traçabilité des sources, séparation faits/interprétations et respect du scope. Elle est commune et non désactivable par les paramètres éditoriaux.

« Enregistrer comme nouveau preset » crée un preset personnel réutilisable. « Créer une nouvelle version » ajoute une version immuable au preset personnel sélectionné. Les anciennes versions restent disponibles et les comptes ne changent jamais automatiquement. L’utilisateur doit sélectionner explicitement une nouvelle version pour charger ses paramètres. Les personnalisations sont enregistrées dans le compte et ne modifient pas le preset d’origine. Les presets intégrés peuvent être copiés, pas modifiés.

Les presets personnalisés sont conservés dans `.xi-account-runs/presets.md`, source Markdown durable. Ce catalogue et les journaux d’exécutions sont privés (dossier 0700, fichiers 0600) ; les sauvegardes doivent conserver cette confidentialité. Chaque propriétaire ne voit que ses presets personnels, en plus des presets intégrés.

## API et sécurité

Toutes les routes exigent une session Better Auth et les mutations vérifient l’Origin. Corps limités à 32 Ko et validés avec Zod ; réponses privées sans cache. L’identité vient de la session. Les exécutions d’autrui retournent 404.

- `GET /api/accounts` : comptes visibles, topics et presets accessibles.
- `PATCH /api/accounts` : `{ id, revision, draft }`, propriétaire seulement ; `revision: null` pour compléter un générateur historique.
- `POST /api/accounts/presets` : `{ name, settings, expectedVersion: 0 }` ou `{ id, name, settings, expectedVersion }` pour une nouvelle version.
- `POST /api/accounts/runs` : `{ topicId }`, alloue le journal privé.
- `GET /api/accounts/runs/:id` et `/events` : état durable et SSE.
- `POST /api/accounts/runs/:id` : `{ action: "resume" }` ou `{ action: "confirm", draft, confirmed: true }`.

Un UUID de compte est alloué dès la proposition. Une confirmation répétée avec le même contenu est idempotente ; un contenu différent est refusé. Les collisions de handles sont vérifiées sous verrou au moment de l’écriture, même si la proposition était libre auparavant. Une erreur après création peut être reprise sans réécrire ni doubler le compte.

## Vérification et limites

`npm run test:accounts` vérifie création/édition, activation, héritage du scope, renommages indépendants, presets et versions, confirmation, reprise, concurrence, erreurs, index reconstructible et compatibilité des générateurs. `npm run test:accounts:e2e` utilise Chrome et le build de production avec coffre et base temporaires ; couvre aussi rechargement, SSE, permissions et navigation mobile.

Validation complémentaire : `npm run test:topics`, `npm run test:publications` (feed inclus), `npx tsc --noEmit`, `npm run lint`, `npm run build`. Pour isoler un build du serveur de développement : `NEXT_DIST_DIR=.next-verify npm run build`, puis la même variable pour les tests navigateur.

Le catalogue est relu intégralement : adapté au MVP, sans pagination. Aucune suppression, collaboration multi-propriétaires, politique automatique de rétention ou intégration LLM n’est ajoutée. `active` exprime l’autorisation de fonctionnement futur du compte ; sa désactivation ne supprime ni ne masque ses publications historiques. La charte et le mode humain sont enregistrés/exposés pour les futurs consommateurs ; aucun contenu n’est généré ou évalué dans ce MVP.
