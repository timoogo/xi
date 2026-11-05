# Architecture de Ξ

Ξ est une instance personnelle et locale. Elle s’appuie sur :

- un serveur Next.js ;
- un worker périodique ;
- une base SQLite unique ;
- un vault Obsidian en Markdown, source de vérité des contenus et des
  configurations ;
- une inférence exclusivement locale (Ollama ou un serveur compatible), sans
  aucun repli vers le cloud.

L’exploitation est décrite dans [operations.md](operations.md), la veille en
détail dans [watch.md](watch.md).

```
  Konstruktor ──propose──▶ aperçu ──validation du propriétaire──▶ déploiement ──▶ ΞAgent éditorial (vault)
                                                                                        │ calendriers
  sources approuvées ──collecte──▶ histoires ──évaluation locale──▶ candidats ──rédaction + vérification──▶ brouillon
                                                                                        │
                                         queue éditoriale (editorial_queue) ◀── projection des brouillons validés
                                                     │
                       diffuseur central (editorial-diffusion) ──▶ publication (vault) ──▶ fil
                                                     │ hors calendrier, urgence
                                                  @arbitre (décision seulement)
  supervision ◀── lecture seule de runs, décisions, queue, arbitrages, calendriers
```

## Processus et file durable

- **Serveur web** : pages, API et Better Auth. Il exécute à la demande les
  tâches des agents système (conversations Konstruktor, arbitrages), qui sont
  aussi reprises par le worker.
- **Worker** (`scripts/watch-worker.ts tick`, timer systemd toutes les 10 min,
  `watch-dev.ts` en développement). Une passe :
  1. planifie de façon idempotente : collectes, évaluations, rédactions,
     alertes, revues Konstruktor, diffusion ;
  2. draine la file ;
  3. resynchronise la queue éditoriale ;
  4. purge selon les rétentions.
- **`watch_job`** : une seule file pour tout le travail, avec baux, jetons de
  bail (fencing), essais, priorités et attentes atomiques
  (`queue.wait(job, until, reason)`). Deux passes concurrentes ne prennent
  jamais la même tâche. Les limites de concurrence s’appliquent à tous les
  processus :
  - inférence : `XI_INFERENCE_CONCURRENCY` ;
  - agents système : au plus `SYSTEM_CONCURRENCY`, avec vieillissement des
    priorités pour qu’ils n’affament pas les ΞAgents éditoriaux ;
  - diffusion : une seule à la fois.
- **Historique** : `xiagent_run` reçoit une ligne par exécution d’une tâche
  qui a un propriétaire (états, résultat, erreur), avec une rétention
  configurable.

## ΞAgents éditoriaux

Un ΞAgent éditorial appartient à un utilisateur. Sa configuration vit dans le
vault (`generators/<handle>/index.md` et YAML, voir
[xiagent-yaml.md](xiagent-yaml.md)) et comprend :

- topics et périmètre ;
- charte et style ;
- sources (catalogue par propriétaire, approuvées explicitement) ;
- calendriers de veille et de publication ;
- politique de publication : autonomie, visibilité, plafonds, seuils ;
- modèle local : agent, puis compte, puis erreur explicite.

Son pipeline, entièrement dans le worker :

1. **Collecte** des sources approuvées uniquement (SSRF, robots.txt,
   politesse). Les articles sont regroupés en histoires, avec des lignées de
   voix indépendantes : copies d’une même dépêche, même éditeur ou même groupe
   comptent pour une seule voix.
2. **Évaluation** par le modèle local : pertinence, fusion, nouveauté,
   extraction des affirmations. **Le code** vérifie ensuite les citations
   exactes, les chiffres et le nombre de voix. Une affirmation n’est
   corroborée qu’avec deux voix indépendantes ou une source primaire.
   L’importance est un score explicable, sans popularité. Le couloir choisi
   est `immediate` (alerte), `night` (fenêtre normale) ou `weekly`.
3. **Rédaction** : seules les affirmations établies sont proposées au
   modèle. Chaque chiffre, citation et attribution est contrôlé, puis relu par
   le modèle (étape `consistency`). Le brouillon est privé, écrit en Markdown
   dans le vault.
4. **Queue éditoriale, puis diffuseur central** (ci-dessous).

Les contenus récupérés sont des **données**, jamais des instructions. Ils
figurent dans les prompts sous forme de blocs JSON déclarés inertes, et les
réponses du modèle sont validées par schéma strict.

## ΞAgents système

Ce sont des singletons de l’instance (`system-agents/registry.ts`). Ils
n’appartiennent à aucun utilisateur et ne publient jamais dans le fil. Chacun
dispose d’une liste fermée de permissions. Leur configuration (activation,
modèle) se trouve dans `system-agents/*.md` et n’est modifiable que par le
propriétaire de l’instance : le premier compte, enregistré une fois pour
toutes dans `xi_instance`. Il n’y a ni rôles ni RBAC. Leurs tâches sont des
`system-task` de la file commune ; elles s’exécutent avec la configuration
locale du demandeur, uniquement pour lui.

### Konstruktor et sa validation

Konstruktor crée et modifie des ΞAgents et des Topics par conversation.

1. **Conversation** (`konstruktor/converse.ts`) : chaque tour est une tâche
   système. La réponse est structurée et validée. Une proposition est
   normalisée dans le vocabulaire du parcours de création (`DraftPatch`,
   `TopicPatch`), limitée à ce que l’utilisateur peut voir (Topics `T#`,
   instances `I#`). Les demandes non prises en charge sont dites, jamais
   configurées. **Rien n’est écrit.**
2. **Aperçu** (`konstruktor/preview.ts`) : les propositions s’appliquent champ
   par champ sur un brouillon. Les modifications manuelles l’emportent
   toujours. Les sources suggérées restent « à décider » tant que le
   propriétaire ne les a pas approuvées.
3. **Validation explicite** : `apply`, avec contrôle de révision (une
   révision périmée renvoie 409 et une nouvelle relecture). La validation crée
   un déploiement en attente.
4. **Déploiement** (`xiagents/deployments.ts`) : journal durable dans
   `.xi-deployments/`, étapes idempotentes persistées une à une. Une
   interruption reprend à l’étape enregistrée, sans doublon ni réécriture
   d’une section modifiée entre-temps. La veille n’est activée qu’à la
   dernière étape. Les contrôles de publication (drapeaux de l’opérateur,
   confirmation publique) ne sont jamais contournés : une autonomie demandée
   reste privée tant que l’opérateur ne l’autorise pas.
5. **Suggestions proactives** (`konstruktor/suggestions.ts`) : des revues
   périodiques ouvrent des conversations Konstruktor sur les problèmes
   détectés (une fois par état). Elles suivent le même circuit d’aperçu et de
   validation.

### @arbitre

`arbiter/arbitration.ts` et `arbiter/decide.ts`. Un ΞAgent qui veut publier
une urgence **hors de son calendrier de publication** mentionne @arbitre. La
mention est interne et structurée : actualité, affirmations établies, sources,
facteurs d’importance, justification. La demande est unique par (agent,
actualité, version). @arbitre répond à une seule question (« publication
immédiate justifiée ? ») et sa réponse est validée strictement.

- **Décision favorable** : elle autorise seulement la tentative de l’alerte.
  Tous les contrôles de publication sont refaits, puis l’alerte passe en tête
  du diffuseur, sans attendre l’espacement.
- **Refus, agent désactivé, modèle indisponible, délai dépassé ou actualité
  obsolète** : retour au circuit normal avec le motif. L’urgence n’est jamais
  retenue.

Les demandes et les décisions restent comme piste d’audit, visibles du seul
propriétaire.

## Queue éditoriale et diffuseur central

`watch/queue.ts` et `watch/publisher.ts`.

- **`editorial_queue`** est une projection idempotente des brouillons validés
  (`watch_candidate` en état `drafted`). Elle est synchronisée avant et après
  chaque drainage, avec les états `ready`, `published`, `withdrawn` et
  `expired`. Préparer un contenu ne dépend jamais du moment de sa diffusion.
- **Diffuseur** (`editorial-diffusion`, une seule tâche à la fois) :
  - il est planifié dès qu’un contenu est prêt ;
  - il choisit par propriétaire selon l’importance, la pertinence, la
    fraîcheur et la diversité des ΞAgents et des Topics ;
  - il respecte un espacement naturel du fil (10 min) ;
  - plafonds et intervalles de chaque ΞAgent sont des limites, jamais des
    quotas ;
  - il tente au plus 5 contenus par propriétaire et par passage ;
  - il attend atomiquement jusqu’à la prochaine échéance, et une alerte dans
    le calendrier le réveille.
- **Éligibilité unique** : `diffusionWait` dit pourquoi un contenu attend.
  - Codes : `legacy`, `operator`, `agent` (pause, autonomie, configuration),
    `expired`, `threshold` (pertinence insuffisante), `outside-window`,
    `daily-cap`, `interval`, `spacing`.
  - Chacun s’accompagne d’un motif lisible et, si elle est connue, de l’heure
    la plus proche.
  - Le diffuseur s’en sert pour décider et compte ses attentes par code dans
    son résultat.
  - La supervision affiche le même calcul par contenu.
  - « Rien de pertinent » (`threshold`) n’est jamais une erreur technique.
- **Publication** : le garde `publishWatchDraft` publie un brouillon une seule
  fois, même avec deux circuits ou deux processus. Une décision est écrite
  dans `watch_decision` à chaque essai.
- **Mode** : `XI_EDITORIAL_DIFFUSION`, `queue` par défaut ou `legacy`
  (créneaux individuels). Un seul circuit publie ; la queue reste à jour dans
  les deux modes.

## Calendriers

`xiagents/calendar.ts`, `xiagents/schedule.ts` et `watch/schedule.ts`. Chaque
ΞAgent possède :

- un calendrier de **veille** (collecte, évaluation) ;
- un calendrier de **publication** (une autorisation, jamais un créneau) ;
- une tolérance (`graceMinutes`) pour finir les rédactions après la veille ;
- l’option « événements majeurs » : hors veille, une détection légère ne
  retient que les histoires déjà portées par plusieurs voix indépendantes.

Les plages par jour de semaine sont évaluées dans le fuseau de l’ΞAgent. Les
plages franchissant minuit et les jours de 23 ou 25 h (règle DST
« compatible ») tombent à leur place réelle. La rédaction d’un candidat
accepté n’est pas bornée par le calendrier de veille : un candidat accepté à
23 h 30 est rédigé dans la nuit.

## Supervision

`xiagents/supervision.ts`, `/dashboard/supervision` et
`GET /api/xiagents/supervision`. Ce sont des projections **en lecture seule**,
limitées aux ΞAgents du visiteur.

- **Calendrier** : heatmap mensuelle et timeline du jour.
- **Queue** : états, motifs d’attente du diffuseur, dernière décision de
  @arbitre.
- **Exécutions** : runs, décisions de publication et arbitrages, avec les
  états « Réussie », « Sans suite », « En attente », « Nouvel essai prévu »,
  « En cours » et « En erreur ».
- **Pagination** : un curseur stable (instant, type, identifiant). Des
  événements au même instant ne sont jamais perdus ni répétés d’une page à
  l’autre, même avec un filtre d’état.

Aucune vue ne modifie une configuration et aucune requête n’est périodique.

## Cohérence des données

| Donnée | Source de vérité | Dérivés |
|---|---|---|
| Publications, brouillons | Markdown du vault | index `publication*` (mtime, observateur de fichiers, réconciliation périodique) |
| ΞAgents, Topics, sources, agents système | vault | caches en mémoire, index `topic_*` et `graph_*` |
| Travail en cours, décisions, arbitrages, runs | SQLite | supervision |
| Prêt à publier | `watch_candidate` | `editorial_queue` |

Une écriture extérieure au vault (Obsidian, un script) est indexée par
l’observateur de fichiers. Elle est prise en compte même si elle survient
pendant une réconciliation complète : l’invalidation attend la fin du scan en
cours, puis en relance un.
