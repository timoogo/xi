# Topics hiérarchiques

## Parcours

`/dashboard/topics` propose une recherche et une hiérarchie de topics globaux, une fiche, l’édition par le créateur, un pipeline de création et un formulaire de routage privé. Sur mobile, la page est accessible depuis le menu du compte.

Une proposition ne publie rien : l’intention, les résultats intermédiaires et les événements sont privés. L’utilisateur vérifie les topics proches, modifie les champs publics, choisit le parent et coche explicitement la validation du périmètre et des relations. La confirmation crée uniquement un topic. Aucun compte éditorial ni publication n’est créé. L’annulation est possible avant confirmation ; ensuite, une erreur se reprend sans recréer le topic. L’URL contient l’identifiant opaque de l’exécution, permettant de la retrouver après rechargement.

## Stockage et invariants

Ce document décrit le catalogue commun. Les topics personnels, créés depuis la recherche `#tag` et visibles par leur seul propriétaire, sont décrits dans docs/search.md.

- `topics/<UUID>.md` dans `XI_VAULT_PATH` : source de vérité, frontmatter YAML lisible. Dossiers indépendants de la hiérarchie logique. UUID immuable, tag unique, nom, description, scope, parent UUID nullable, relations UUID, anciens tags, dates, auteurs et révision.
- `.xi-topic-runs/<UUID>.md` : intentions, propositions, confirmations, étapes et journal privé. Dossier créé en mode 0700, fichiers en 0600. Jamais lu par le feed, les publications ou le graphe. Les sauvegardes du coffre doivent respecter cette confidentialité ; ne pas exporter ce dossier comme contenu public.
- SQLite : `topic_index`, `topic_tag` (tags actuels et anciens), `topic_routing` (enfants directs). Aucune intention dans ces tables. `npm run topics:reindex` reconstruit ces tables depuis Markdown, sans toucher aux tables d’authentification/publications. Chaque lecture de catalogue réconcilie également l’index.
- Un tag enfant spécialise directement le tag parent. Les cycles, parents absents, relations absentes/dupliquées/vers soi et collisions avec des anciens tags sont refusés. Le scope parent n’est jamais réduit lors d’une création d’enfant.
- Les renommages conservent les UUID et les liens, actualisent les tags descendants et réservent les anciens tags. Une révision optimiste empêche l’écrasement d’une modification concurrente. Le créateur du parent peut effectuer ce changement structurel de ses descendants ; leur contenu et leur créateur restent inchangés.
- Chaque écriture utilise `writeAtomic` (fichier temporaire, fsync, renommage). Un renommage de sous-arbre prépare `topics/.pending.md`, puis remplace les fichiers. Toute opération suivante termine ce journal avant de lire ou écrire : reprise en avant après interruption, sans état partiel exposé par l’API.
- Une connexion SQLite dédiée à `topics/.writer-lock.sqlite` sérialise les opérations entre processus sur un même hôte. Cette base ne contient aucune donnée métier ; son verrou est libéré par le système en cas de crash. Ne pas supprimer le fichier pendant qu’un serveur tourne. Ne pas utiliser ce mécanisme sur un partage réseau multi-hôtes.
- Les modifications externes sont validées avant de remplacer l’index ; un fichier invalide bloque la réconciliation en conservant l’index précédent. Modifier hors ligne les champs structurels ou utiliser l’API pour bénéficier du verrou et du journal. La validation automatique des scopes est structurelle : la spécialisation sémantique est confirmée par l’humain.

## Pipeline et SSE

`POST /api/topics/runs` alloue une exécution privée ; `POST /api/topics/runs/:id` avec `action: resume` exécute l’analyse. L’interface ouvre donc le flux avant la phase d’analyse. Six étapes déterministes produisent les candidats, le parent, le tag, le scope et les relations. La septième attend l’humain. `action: confirm` reçoit `draft` et `relationsConfirmed: true`. Les quatre dernières étapes écrivent le Markdown, indexent SQLite, reconstruisent le routage et vérifient l’intégrité.

Chaque transition est persistée avec numéro séquentiel, horodatage, résultat ou erreur. Une étape n’est terminée qu’après son opération. `resume` rejoue les opérations idempotentes : l’UUID est alloué dès la proposition, et une écriture déjà effectuée est reconnue. Une analyse échouée peut aussi être reprise, sans contourner la confirmation. Les opérations sont attendues par la requête HTTP, sans travail en arrière-plan non durable ; une interruption se reprend explicitement depuis la page.

`GET /api/topics/runs/:id/events` fournit des instantanés SSE du journal durable, vérifiés toutes les 500 ms. Chaque connexion reçoit l’état intégral, même avec un ancien `Last-Event-ID`. L’identité d’événement inclut l’UUID, la séquence et l’état ; le client remplace son instantané et refuse les états plus anciens. Les journaux sont ainsi dédupliqués, même après redémarrage. Les flux se renouvellent après 25 secondes et revalident la session à chaque passage. Les changements d’état global sont annoncés avec `aria-live`, les journaux détaillés restent silencieux et dépliables au clavier.

## Permissions et API

Better Auth fournit l’identité, jamais le corps de requête. Tous les endpoints exigent une session. Les mutations contrôlent l’Origin configurée ; les corps sont limités à 32 Ko et validés avec Zod. Les réponses sont privées, non mises en cache. Lire/reprendre/confirmer/annuler une exécution d’autrui retourne 404. Les topics confirmés sont partagés entre utilisateurs connectés ; seule leur création et leur contenu confirmé sortent du périmètre privé. Leur édition est réservée à leur créateur.

`GET /api/topics` renvoie le catalogue ; `PATCH /api/topics` modifie un topic avec `id`, `revision`, `draft` et `relationsConfirmed`. Les tags historiques restent recherchables et routables vers le même UUID.

`POST /api/topics/route-request` reçoit une intention privée et renvoie `primaryId`, `secondaryIds`, `explanation`. Une correction explicite peut fournir `correction: { primaryId, secondaryIds }`. Le responsable est distinct des topics de contexte. Sans correspondance, `primaryId` est nul : une sélection humaine est nécessaire. Ce formulaire ne lance aucun traitement éditorial, ne publie rien et ne persiste pas la demande routée ; le contrat est disponible pour les futurs consommateurs.

## Analyse et limites de cette version

`TopicAnalyzer` reste le point de remplacement par un futur agent. La proposition actuelle extrait d’abord le sujet des formulations usuelles (« Je souhaite suivre… », « Je veux me renseigner sur… », « J’aimerais comprendre… », « Parle-moi de… », « Je m’intéresse à… »). Le petit catalogue `src/lib/topics/subjects.ts` reconnaît la politique générale, française, allemande et européenne ainsi que leurs élections. Il produit un nom, un tag hiérarchique et un scope descriptif, sans recopier l’intention. Les sujets inconnus ou mixtes gardent une proposition racine prudente, avec un périmètre explicitement à préciser. Une ressemblance lexicale ne suffit plus à inventer un parent.

Les parents et doublons sont recherchés par tag canonique et anciens tags. Un doublon est présenté avec son UUID, son scope et ses relations existantes ; sa recréation reste refusée. Le routage privé conserve son classement explicable par mots et synonymes et reste corrigible par l’humain.

### Parents manquants

Pour « Je souhaite suivre la politique française », le sujet demandé est `Politique française`, le tag `politiks.france` et le scope `Politique, institutions et actualité politique françaises`. Si `politiks` manque, la page affiche sa proposition et explique son rôle. « Proposer le parent manquant » ouvre une exécution liée (`action: parent` sur la route des runs), sans créer de topic. Chaque exécution conserve un UUID de topic stable et exige sa propre confirmation. Les liens privés `parentRunId` et `returnRunId` sont persistés et les événements du pipeline tracent cette proposition.

Après confirmation du parent, « Continuer vers le topic demandé » reprend l’exécution de l’enfant, résout son parent et demande une nouvelle confirmation. Le même mécanisme traite plusieurs niveaux, par exemple `politiks` puis `politiks.france` avant `politiks.france.elections`. Un rechargement conserve les liens. Aucun enfant n’est créé avant que son parent existe. Un parent déjà confirmé reste un topic autonome valide si l’utilisateur abandonne l’enfant ; il n’est pas supprimé. Une collision concurrente indique le topic existant et permet de revenir à l’enfant pour le réutiliser, sans modifier son scope ni ses relations. Une modification manuelle du parent dans ce parcours est respectée via son UUID.

Aucun changement du transport SSE, des presets ou de l’héritage du scope des comptes : un compte proposé depuis ce topic reçoit `politiks.france` si disponible, `Politique française` comme nom et la référence UUID au topic pour son scope.

Le catalogue est intégralement relu et validé sous verrou : choix adapté à cette première version, sans pagination ni optimisation pour des dizaines de milliers de topics. Les intentions et journaux restent conservés jusqu’à suppression administrative hors ligne ; aucune politique de rétention automatique n’est ajoutée. Aucun modèle d’autorisation collaborative, suppression de topic, migration des générateurs en topics ou intégration automatique au feed/conversations/graphe n’est introduit.

## Vérification

- `npm run test:topics` : invariants, doublons, concurrence, libération du verrou après crash, reprise, reconstruction, alias, routage et isolation des intentions.
- `npm run test:topics:e2e` : build de production requis ; Chrome à `/usr/bin/google-chrome-stable` ou `XI_E2E_CHROME`. Création et édition au clavier, sous-topic, correction humaine, restauration après rechargement, SSE avec ancien curseur, sessions et Origin, navigation mobile. Coffre et base temporaires isolés.
- `npx tsc --noEmit`, `npm run lint`, `npm run build`.

Pour un build isolé : `NEXT_DIST_DIR=.next-topics npm run build`, puis la même variable pour les tests d’authentification et de navigateur.

Relations Topic ↔ Topic durables (provenance, corrections, exclusions) : voir `docs/topic-relations.md`.

Découverte automatique de concepts, associations inférées et relations proposées : voir `docs/topic-discovery.md`.
