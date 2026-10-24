# Veille autonome des ΞAgents

Moteur qui surveille, vérifie et publie pour chaque ΞAgent. Orchestration sur le
Raspberry Pi, inférence 100 % locale sur le Mac mini (aucun repli cloud : si
l’inférence est indisponible, les tâches attendent). Construction en cinq phases ;
cette page décrit ce qui existe. **La publication automatique est implémentée et
désactivée par défaut** : voir « Mise en service progressive ».

| Phase | Contenu | État |
|---|---|---|
| 1 | Verrou interprocessus, file durable, scheduler, politique par agent | Livrée |
| 2 | Catalogue de sources (découverte + approbation), collecte, regroupement, diagnostic | Livrée |
| 3 | Client d’inférence local, pertinence, nouveauté, extraction, vérification, importance | Livrée |
| 4 | Rédaction locale, contrôles, brouillons privés sourcés, relecture | Livrée |
| 5 | Publication autonome, alertes, bilan hebdomadaire, pilotage | Livrée, désactivée par défaut |

## Processus

Le serveur Next (`xi-web`) et le worker (`xi-watch`) sont deux processus qui
partagent le vault et la base SQLite (WAL). Le worker n’a pas de serveur HTTP :
un timer systemd lance `watch-worker tick`, une passe courte et idempotente.
Les publications qu’il écrira seront vues par Next via la surveillance du vault.

`publishGenerated` est le seul écrivain des publications d’agents. Les verrous en
mémoire ordonnent les appels d’un processus ; un verrou SQLite dans
`<vault>/.xi-locks/.writer-lock.sqlite` (hors de `posts/`, donc sans
réindexation) sérialise les processus. Sous ce verrou, le dossier de l’agent est
relu depuis le disque : un identifiant déjà publié par l’autre processus est
reconnu (idempotence) et les numéros de dossier ne se chevauchent pas. Le
système libère le verrou si un processus meurt.

## Politique par agent

Clé `watch` de premier niveau dans `generators/<handle>/index.md`, à côté du bloc
`editorial` que le formulaire de configuration réécrit :

```yaml
watch:
  enabled: false            # désactivée par défaut
  paused: false             # pause sans perdre la configuration
  maxPerDay: 3              # plafond glissant sur 24 h (1–24) ; aucun quota minimal
  minIntervalMinutes: 240   # intervalle minimal entre deux publications (15 min – 7 j)
  testMaxPerDay: 10         # plafond séparé des publications de test (1–100), défaut si absent
  alertThreshold: 0.85      # importance minimale d’une alerte majeure (0,5–1)
  nightThreshold: 0.45      # importance minimale de la fenêtre nocturne, < alertThreshold
  revision: <uuid>
  updatedAt: …
  updatedBy: <propriétaire>
```

`GET` et `PATCH /api/xiagents/<id>/watch` (`{ revision, policy }`) sont réservés
au propriétaire (404 sinon), avec Origin vérifiée, corps de 4 Ko au plus,
validation stricte et révision optimiste (409). Une valeur illisible, modifiée à
la main, désactive l’agent (`valid: false`) sans casser le catalogue ; le
propriétaire peut la réécrire avec `revision: null`. Le panneau « Veille
autonome » de la page du ΞAgent permet de les modifier et de mettre en pause.

Les publications de test (`test_content: true`, colonne `test_content` de l’index)
ne comptent jamais dans le plafond ni l’intervalle réels. Elles ont leur propre
plafond glissant `testMaxPerDay`, appliqué par l’écrivain sous le verrou (429 au
dépassement ; une nouvelle tentative idempotente n’est pas refusée).

## Scheduler

- Fenêtre 03:00–06:00, Europe/Paris, avec changements d’heure (calcul par
  `Intl`, testé sur les nuits de mars et d’octobre).
- Chaque agent a un créneau stable dans les 150 premières minutes (hachage de
  son UUID). Le dimanche, un bilan hebdomadaire est planifié 10 minutes après.
- Chaque passe planifie la prochaine fenêtre des agents actifs, activés et non
  en pause. Les clés `publication-window:<agent>:<date>` et
  `weekly-review:<agent>:<date>` rendent la planification idempotente.
- Avant toute publication, `publicationGate` vérifie : mode automatique
  global, agent actif, politique valide, activée, sans pause ; fenêtre (sauf
  publication immédiate) ; intervalle minimal ; plafond sur 24 h. Le bilan exige
  la fenêtre du dimanche et aucune publication depuis sept jours. Toutes les
  publications IA de l’agent comptent, y compris les publications de test.
- Ces règles sont relues au moment de l’exécution : une pause s’applique aux
  tâches déjà planifiées. Une fenêtre manquée (worker arrêté) s’exécute une
  fois, constate qu’elle est hors fenêtre et n’est pas rejouée.
- Sans pipeline de candidats (phase 3), une fenêtre autorisée ne publie rien.
- Chaque fenêtre mesure la relecture complète de l’index des publications
  (`indexMs` dans le résultat de la tâche, avertissement au-delà de 2 s) pour
  repérer un ralentissement quand le vault grossit.

## File durable

Table `watch_job` de la base applicative (non dérivée du vault : elle n’est pas
supprimée avec les index reconstructibles ; à sauvegarder avec la base).

- `enqueue` est idempotent par clé, pour toute la vie de la tâche.
- `claim` prend la plus ancienne tâche due en `BEGIN IMMEDIATE`, avec un bail et
  un jeton : un seul processus l’obtient. Le bail est renouvelé pendant
  l’exécution ; un bail expiré (worker mort) rend la tâche reprenable et
  l’ancien détenteur ne peut plus rien écrire.
- Échec : nouvel essai après 1, 2, 4 min… (6 h au plus), puis `failed` avec
  l’erreur abrégée. `wait` (inférence indisponible) replanifie sans consommer
  d’essai.
- Les tâches terminées sont purgées après 30 jours.

## Catalogue de sources

`<vault>/watch/sources/<uuid>.md` (dossier privé 0700), un fichier par source,
propre à un propriétaire et partagé entre ses ΞAgents par attribution de topics :
URL du flux, type (`feed` RSS/Atom ou `json` pour une API officielle avec son
mappage `itemsPath`, `url`, `title`, `summary`, `publishedAt`, `id`), site,
éditeur, groupe propriétaire, orientation éditoriale déclarée (non évaluée par
défaut, jamais déduite), fiabilité estimée (domaine institutionnel, citations
par des sources approuvées, HTTPS, articles datés : chaque raison est affichée)
puis éventuellement fixée par le propriétaire, fréquence de collecte.

- **Seules les sources `approved` sont collectées.** Toute proposition (manuelle
  ou découverte par un agent) attend une décision explicite.
- Transitions : proposée → approuvée ou rejetée ; approuvée ↔ désactivée ;
  suppression depuis tout état. Chaque décision est ajoutée à `history`
  (date, auteur, note, champs modifiés). Révision optimiste (409).
- La suppression garde une pierre tombale : la source disparaît des listes et
  n’est jamais reproposée, l’historique reste lisible dans le fichier.
- Un fichier invalide est ignoré (jamais collecté) et compté dans le diagnostic.
- Découverte par l’agent, une fois par jour : domaines liés par au moins deux
  sources approuvées de ses topics dans la semaine (par leur source d’origine,
  pas par un flux qui les relaie), absents du catalogue. Le site est analysé
  (`<link rel="alternate">`), le flux doit être valide et non vide. Trois
  propositions par jour au plus, aucune au-delà de vingt en attente.

API (session, Origin, propriétaire seulement, sinon 404) :
`POST /api/xiagents/<id>/sources` `{ url, api? }` propose une source pour les
topics de l’agent ; `POST /api/watch/sources/<id>`
`{ action: approve|reject|disable|delete|update, revision, note?, edits? }`.

## Collecte

- `createSafeFetch` : http(s) uniquement, sans identifiants, ports 80/443,
  toutes les adresses résolues publiques (privées, boucle locale, lien local,
  CGNAT, documentation, multicast, IPv6 locales, NAT64/6to4 refusées), connexion
  épinglée sur l’adresse vérifiée (pas de rebinding DNS), chaque redirection
  revérifiée (3 au plus, jamais HTTPS → HTTP), taille limitée après
  décompression (2 Mo ; gzip, deflate, br), délai global de 15 s, corps des
  réponses d’erreur ignoré.
- `createPoliteFetch`, partagé entre processus par `watch_host` : robots.txt
  (RFC 9309, jeton `XiWatch`, cache 24 h ; 4xx = autorisé, 5xx ou injoignable =
  refusé et réessayé après 1 h), au moins 5 s ou le Crawl-delay entre deux
  requêtes par origine, pause sur 429/503 selon Retry-After (1 h par défaut,
  24 h au plus). Les cibles de redirection doivent aussi autoriser robots.txt.
- Requêtes conditionnelles `If-None-Match`/`If-Modified-Since` : un 304 ne
  télécharge rien. Après une erreur, la prochaine collecte s’éloigne
  (fréquence × 2^erreurs, 24 h au plus) ; robots.txt refusé : 24 h. Une origine
  à ménager replanifie la tâche sans consommer d’essai.
- Flux : DTD et entités déclarées refusées, 200 entrées au plus, texte seul
  (aucun HTML conservé), liens relatifs résolus sur l’URL du flux, charset du
  serveur ou de la déclaration XML. Aucune page d’article n’est téléchargée.
- Une source n’est collectée que si un agent actif, activé et non en pause de
  son propriétaire couvre l’un de ses topics.

## Regroupement

- URL normalisées (fragment, paramètres de suivi et AMP retirés, requête triée,
  `www.`/`m.` ignorés) : un même article n’est stocké qu’une fois par
  propriétaire ; chaque flux qui le porte est conservé (`watch_item_seen`).
  Le `guid` d’une source reconnaît aussi un article dont l’URL change.
- Même événement : vocabulaire du titre pondéré avec le résumé, sans mots
  vides, dans une fenêtre de 72 h (seuil 0,35).
- Confirmations indépendantes : les articles d’un événement sont fusionnés en
  une seule voix s’ils sont des copies du même texte (titre identique ou
  résumé quasi identique), créditent la même agence (AFP, Reuters, AP…) ou en
  sont la dépêche, ou viennent du même éditeur ou du même groupe propriétaire.
- Chaque article garde éditeur, URL d’origine et normalisée, date publiée et
  date de collecte, crédits et voix. Rétention : 30 jours.

## Diagnostic

La page `/dashboard/xiagents/<id>` (propriétaire seulement) affiche : état et
paramètres de veille, pause, publication automatique (toujours désactivée),
prochaine fenêtre ; sources en attente, actives, rejetées ou désactivées avec
fiabilité, orientation, état de collecte et historique ; proposition d’une
source ; dernières collectes et erreurs ; actualités regroupées avec leurs
voix ; tâches et prochaines exécutions.

## Inférence locale

`XI_INFERENCE_URL` (ex. `http://mac-mini.lan:11434`), `XI_INFERENCE_API`
(`ollama` par défaut, ou `openai` pour llama.cpp, LM Studio, MLX…),
`XI_INFERENCE_MODEL` (modèle par défaut), `XI_INFERENCE_TIMEOUT_MS` (180 s par
défaut, 10 min au plus), `XI_INFERENCE_ALLOW` (adresses IP explicites
supplémentaires, jamais des noms). Le modèle d’un ΞAgent est sa « référence
fournisseur / modèle » ; à défaut, `XI_INFERENCE_MODEL`.

- Le serveur doit résoudre vers une adresse locale (boucle locale, réseaux
  privés, plage Tailscale 100.64/10, IPv6 ULA) ou listée : toute adresse
  publique, lien local (métadonnées cloud) ou redirection est refusée avant
  connexion. Il n’existe aucun autre fournisseur ni repli.
- Sans configuration, aucune évaluation n’est planifiée. Serveur injoignable,
  délai dépassé ou erreur HTTP : la tâche est replanifiée 15 min plus tard sans
  consommer d’essai ; configuration refusée : 1 h.
- Décodage déterministe (température 0, graine fixe), réponses JSON validées
  par Zod, un nouvel essai sur réponse invalide, puis nouvel essai de la tâche ;
  après trois tâches en échec, le candidat passe « en attente » avec la raison.
- Les textes d’articles sont des données : le modèle reçoit la consigne de ne
  suivre aucune instruction qu’ils contiennent, et le code ne lui fait jamais
  confiance pour la vérification.

## Candidats éditoriaux

Un candidat par ΞAgent et par actualité (`watch_candidate`), évalué par
étapes ; chaque étape est enregistrée avant la suivante, et une reprise
repart de la première étape manquante sans redemander les précédentes.

1. **Pertinence** (modèle) : score, justification, aspects hors périmètre et un
   seul topic de l’agent. Moins de 0,5 ou sans topic : rejeté.
2. **Même événement** : les actualités récentes proches mais sous le seuil
   lexical sont soumises au modèle ; s’il s’agit du même fait précis, elles sont
   fusionnées (la plus ancienne est conservée puis réévaluée).
3. **Nouveauté** : comparaison avec les publications réelles des 30 derniers
   jours et les candidats retenus des 7 derniers jours (préfiltre lexical, puis
   modèle). « Déjà traité » : rejeté ; « nouveau développement » : le lien de
   continuité est préparé (publication ou actualité liée), jamais créé. Un
   verdict sans référence valide est traité comme nouveau.
4. **Faits** : le modèle extrait des affirmations atomiques (fait, déclaration
   attribuée, hypothèse, interprétation) avec leurs citations ; le code décide :
   - une citation doit figurer telle quelle dans le texte de la source (seules
     typographie et espaces sont normalisées ; 3 mots et 12 caractères au
     minimum), sinon elle est rejetée ;
   - tout chiffre de l’affirmation doit figurer dans une citation valide ;
   - voix indépendantes = lignées de la collecte (même dépêche, agence,
     éditeur ou groupe = une voix) : 2 voix = corroboré, 1 = une seule voix ;
   - une source officielle est primaire pour ses propres actes et déclarations
     (attribution à elle-même), et une voix ordinaire pour le reste ;
   - hypothèses et interprétations ne deviennent jamais des faits ;
   - les contradictions signalées mettent le candidat en attente.
   Au moins une affirmation établie : vérifié ; une seule voix : en attente,
   réévalué quand l’actualité reçoit un nouvel article ; rien de vérifiable :
   rejeté.
5. **Importance** : impact réel estimé (45 %), pertinence (15 %), nouveauté
   (15 %, réduite pour un développement), voix indépendantes plafonnées à 3
   (15 %), source primaire officielle (10 %). Les nombres d’articles et
   d’éditeurs n’y entrent pas. Voie : alerte majeure (seuil d’alerte, au moins
   deux voix ou une source primaire, plafond et intervalle réels respectés,
   sinon différée), fenêtre nocturne (seuil nocturne), bilan hebdomadaire.
6. **Un seul ΞAgent par actualité et par propriétaire** : le plus pertinent la
   garde, les autres sont rejetés avec la raison.

Le panneau du ΞAgent affiche pour chaque candidat : sujet, statut, voie,
scores, raisons, justification de pertinence et de nouveauté, continuité,
facteurs d’importance, sources et voix, affirmations avec leur statut et leurs
citations, modèle utilisé. Rien n’est rédigé ni publié à ce stade.

## Brouillons

Les candidats retenus pour la fenêtre nocturne ou une alerte deviennent des
brouillons privés (`draft-candidate`) ; le matériau hebdomadaire attend le bilan.

- Le modèle local reçoit la charte, le preset (ton, structure, profondeur,
  public), le sujet et **les seules affirmations établies ou qualifiées** avec
  leurs citations ; les affirmations à une seule voix, contredites ou non
  étayées ne lui sont jamais proposées. Sortie JSON validée par Zod : format,
  résumé, messages et affirmations utilisées par chacun.
- Contrôles du code : pas d’URL ni de section « Sources » dans le texte ; tout
  chiffre et toute citation entre guillemets doivent figurer dans les citations
  des affirmations du message ; une déclaration reste attribuée ; une hypothèse
  ou une interprétation reste signalée ; au moins une affirmation établie ;
  post = un message ; thread = 2 à 10 messages, jamais plus que d’affirmations,
  chaque message en apportant une nouvelle.
- Puis une relecture de cohérence par le modèle local (chaque phrase soutenue
  par ses citations). Les problèmes sont renvoyés au modèle ; le troisième essai
  impose un post court sur les affirmations établies ; sinon le candidat passe
  en attente avec les raisons. Aucun brouillon n’est écrit hors de ces règles.
- Écriture par `saveWatchDraft` (même écrivain et mêmes verrous que les
  publications de test) : `posts/_generators/<agent>/post_…` ou `thread_…`,
  `status: draft`, `visibility: private`, `generated_by: watch-draft-v1`,
  `review: pending`, sans `test_content` ni marquage fictif. Le bloc `watch`
  garde l’actualité, sa version, le modèle, les versions de consigne, la voie,
  les scores, le lien de continuité préparé et les affirmations utilisées.
  Chaque article utilisé devient une note `_sources/` (URL, titre, éditeur,
  dates, citations exactes, réserve « résumé du flux seulement » et, pour une
  source officielle, sa portée) ; chaque message se termine par `## Sources`.
- Identifiant déterministe (agent, actualité, version) : une tâche répétée ou
  reprise retrouve le même brouillon ; le texte validé est conservé dans le
  candidat, un arrêt entre l’écriture et la mise à jour ne relance pas le modèle.
- Un brouillon n’apparaît dans aucun fil et n’est lisible que par le
  propriétaire de l’agent.

Relecture (`POST /api/xiagents/<id>/drafts/<draftId>`, propriétaire seulement,
Origin vérifiée, révision optimiste) :
- `update` remplace la prose de chaque message ; sa section de sources est
  conservée et la prose est contrôlée contre ces sources (URL, chiffres,
  citations) ;
- `reject` garde le dossier comme brouillon rejeté (`review: rejected`) et
  rejette le candidat ;
- `approve` publie **en privé** (visible par le seul propriétaire) pour tester
  le parcours de bout en bout. Rien ne permet de rendre ces brouillons publics.

## Publication autonome

Trois verrous successifs, tous fermés par défaut :
1. `XI_WATCH_AUTOPUBLISH=true` sur le worker (opérateur) ;
2. le **mode autonome** de l’agent (`autoPublish`) ;
3. pour le public : `visibility: public` avec une **confirmation explicite**
   enregistrée par le serveur (`publicConfirmedAt`, jamais fournie par le
   client, effacée au retour en privé) **et** `XI_WATCH_AUTOPUBLISH_PUBLIC=true`.
   Sans l’un d’eux, la publication est reportée, jamais rabattue en privé.

- **Fenêtre nocturne** (tâche `publication-window` au créneau de l’agent) :
  brouillons validés par importance décroissante ; après une publication,
  la tâche attend l’intervalle minimal dans la fenêtre ; elle s’arrête au
  plafond. Aucun quota minimal : sans brouillon, rien n’est publié.
- **Alerte immédiate** (`publish-alert`, hors fenêtre) : seulement pour les
  candidats classés « alerte majeure » à l’évaluation (importance sans
  popularité, au moins deux voix ou une source primaire), dans la limite de
  `maxImmediatePerDay` (0 désactive) et de l’intervalle ; sinon la fenêtre
  nocturne. La plus importante passe en premier.
- **Bilan hebdomadaire** (dimanche, aucune publication réelle depuis 7 jours) :
  les candidats vérifiés restés sous le seuil nocturne et d’importance ≥ 0,25
  sont retenus, chacun pour sa propre publication (un post, un sujet), puis
  rédigés et publiés aux fenêtres suivantes. Sans matière : aucun bilan.
- **Contrôles au moment de publier** : configuration de l’agent relue
  (pause, désactivation, mode autonome, visibilité) ; actualité non obsolète
  (6 h pour une alerte, 36 h pour la nuit, 8 jours pour le bilan) et inchangée
  depuis la rédaction (sinon réévaluée) ; chaque citation toujours présente
  dans son article ; chaque article encore porté par une source approuvée
  (reporté si ses sources échouent durablement) ; affirmations toujours
  établies ; pas de publication de la même actualité dans la semaine ni de
  publication équivalente sur 72 h ; brouillon en attente, à la révision
  validée (une modification exige une approbation manuelle ; un brouillon
  rejeté ou retiré n’est jamais publié). Puis, **sous le verrou
  interprocessus**, la configuration, le plafond, l’intervalle et le plafond
  d’alertes sont relus à l’instant exact, et la décision est enregistrée avant
  sa libération.
- **Idempotence** : un brouillon publié n’est jamais republié ; une
  interruption entre l’écriture et l’enregistrement est reconnue au passage
  suivant et la décision n’est enregistrée qu’une fois. Deux workers ne
  dépassent pas les plafonds.
- Chaque tentative laisse une décision traçable (`watch_decision`, 90 jours) :
  publiée, reportée, abandonnée (avec retrait du brouillon), non publiée,
  retenue pour le bilan.

Pilotage dans le panneau du ΞAgent : mode autonome, visibilité et
confirmation publique, plafonds (24 h, alertes), intervalle, seuils, pause
immédiate, état des autorisations de l’opérateur, prochain créneau, dernier
passage et erreurs du worker (alerte après 30 min sans passage), journal des
décisions de publication.

## Mise en service progressive

Chaque étape dure au moins une semaine ; passer à la suivante seulement si les
précédentes sont satisfaisantes.

1. **Veille sans publication** : installer le timer (`XI_WATCH_AUTOPUBLISH`
   absent), approuver 10 à 20 vrais flux pour un seul ΞAgent pilote, activer sa
   veille. Vérifier collectes, regroupements, voix indépendantes, propositions
   de sources ; aucune publication possible.
2. **Évaluation et brouillons** : configurer `XI_INFERENCE_URL` vers le Mac
   mini et la référence de modèle de l’agent. Relire candidats, faits,
   citations et brouillons ; rejeter ou modifier ; approuver à la main quelques
   brouillons (publication privée) pour tester le parcours complet.
3. **Publication privée automatique** : `XI_WATCH_AUTOPUBLISH=true`, mode
   autonome de l’agent pilote en visibilité privée, plafonds bas (1 par jour,
   alertes à 0 puis 1). Relire chaque publication et le journal des décisions.
4. **Publication publique** : uniquement après les étapes précédentes, pour
   l’agent pilote seulement : `XI_WATCH_AUTOPUBLISH_PUBLIC=true`, visibilité
   publique avec la confirmation explicite, plafonds bas. Surveiller, puis
   élargir agent par agent. Arrêt immédiat : pause de l’agent, ou retrait de
   `XI_WATCH_AUTOPUBLISH_PUBLIC` (repli privé impossible : tout est reporté),
   ou `XI_WATCH_DISABLED=true`.

## Tables SQLite de la veille

Données opérationnelles, non dérivées du vault (à sauvegarder avec la base) :
`watch_job`, `watch_host`, `watch_source_state`, `watch_fetch_log` (100 entrées
par source), `watch_item`, `watch_item_seen`, `watch_story`, `watch_candidate`
et `watch_claim` (30 jours après leur dernière mise à jour), `watch_decision`
(90 jours) et `watch_worker` (dernier passage, dernière erreur). L’index des
publications passe en version 6 (colonne `test_content`) : il est reconstruit
automatiquement depuis le Markdown.

## Exploitation sur le Raspberry Pi

Migration (crée aussi `watch_job`) : `npm run db:migrate`. Passe manuelle :
`npm run watch:tick` ; la sortie ne contient que des compteurs.

| Variable | Effet |
|---|---|
| `XI_WATCH_DISABLED=true` | Arrêt complet du worker. |
| `XI_WATCH_AUTOPUBLISH=true` | Autorise la publication automatique (privée) des agents en mode autonome. Étape 3 de la mise en service. |
| `XI_WATCH_AUTOPUBLISH_PUBLIC=true` | Autorise en plus la publication automatique publique des agents qui l’ont confirmée. Étape 4. |

```ini
# /etc/systemd/system/xi-watch.service
[Service]
Type=oneshot
User=xi
WorkingDirectory=/opt/xi
EnvironmentFile=/opt/xi/.env.local
ExecStart=/usr/bin/node --import tsx scripts/watch-worker.ts tick
TimeoutStartSec=15min
Nice=10

# /etc/systemd/system/xi-watch.timer
[Timer]
OnCalendar=*:0/10
Persistent=true
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
```

Une passe s’arrête de prendre des tâches après 8 minutes ; les baux couvrent une
passe plus longue et deux passes concurrentes ne prennent jamais la même tâche.

## Vérification

`npm run test:watch` (phases 1 et 2), avec serveurs de flux locaux et horloge
simulée : robots.txt, RSS/Atom/RDF/JSON, DTD refusées, crédits d’agences,
normalisation d’URL, copies et confirmations indépendantes, protection SSRF
(adresses, ports, schémas, identifiants, rebinding, redirections vers le réseau
privé ou en boucle), tailles, compression, délais, erreurs réseau, ETag, 429,
Crawl-delay, robots injoignable, catalogue (isolation entre comptes,
transitions, historique, pierres tombales, fichier invalide), collecte de bout
en bout (sources approuvées seulement, doublons, histoires, erreurs et reprise,
robots, pause, redémarrage, découverte), quotas de test séparés ; puis
fenêtres et changements d’heure, créneaux, règles de
publication, planification idempotente, file (baux, jetons, essais, attente,
purge), quatre processus concurrents sur la même file, renouvellement de bail,
politique (propriétaire, révision, conservation par le formulaire, valeur
invalide), trois processus publiant en concurrence sans doublon, passes
complètes avec horloge simulée, sans aucune publication écrite.
Phase 3 (`watch-evaluate.test.ts`) : client réel contre des serveurs Ollama et
OpenAI simulés, adresses locales, cloud et rebinding refusés, indisponibilité,
délais, redirections et réponses invalides typées ; vérification (citations
inventées, chiffres hallucinés, copies d’agence, source officielle primaire ou
non, interprétations, contradictions), importance sans popularité, voies et
plafonds ; pipeline avec un modèle simulé sur des actualités fictives :
hors périmètre, contradictions, voix unique puis corroborée, doublon
reformulé, développement d’une publication réelle, fusion sémantique, injection
d’instructions dans un article, arbitrage entre agents, isolation entre
comptes, serveur indisponible puis reprise sans perte d’étape, réponses
invalides jusqu’à la mise en attente.
Phase 4 (`watch-draft.test.ts`) : contrôles (URL, chiffres, citations,
attributions, prudence, threads artificiels), post et thread sourcés, Markdown
et notes de sources sur disque, jamais de marquage fictif, chiffre halluciné
et citation inventée corrigés au second essai, thread artificiel ramené à un
post, déclaration présentée comme un fait mise en attente, relecture de
cohérence, indisponibilité, idempotence, arrêt entre écriture et mise à jour,
redémarrage, planification, relecture du propriétaire (modifications dans les
sources, refus, révision périmée, rejet, approbation privée, isolation).
Phase 5 (`watch-publish.test.ts`) : fenêtre nocturne (espacement adaptatif,
plafonds, idempotence, actualité obsolète, privé par défaut), alertes (plafond
propre, hors fenêtre, fraîcheur, une alerte par événement, popularité
insuffisante, la plus importante d’abord), configuration relue au moment exact
(pause, mode autonome, confirmation publique, autorisation de l’opérateur,
changement pendant le verrou), bilan hebdomadaire (valeur, un sujet par post,
publication récente), sources échouant ou désactivées, citation modifiée,
brouillon modifié ou rejeté, nouvelles informations, publication équivalente,
interruption pendant la publication, workers concurrents, isolation entre
comptes, nuits de changement d’heure.
`test:xiagents:pages` couvre en HTTP l’API de politique, les propositions
refusées par la protection SSRF (127.0.0.1, métadonnées cloud, ports, `file:`),
l’isolation et les décisions sur les sources ; `test:xiagents:e2e` le panneau
(activation, pause, proposition refusée, approbation, historique, suppression).

## Limites connues

- Aucune page d’article n’est téléchargée : copies et crédits sont détectés sur
  le titre et le résumé fournis par le flux.
- Le regroupement par vocabulaire peut séparer un même événement formulé très
  différemment ou, plus rarement, réunir deux événements proches ; la phase 3
  (modèles locaux) affinera la pertinence.
- La fiabilité estimée est indicative ; l’orientation éditoriale n’est jamais
  déduite automatiquement.
- `package-lock.json` n’est pas mis à jour par pnpm pour `fast-xml-parser`.
- La vérification porte sur les titres et résumés des flux : une citation
  exacte prouve qu’un texte dit quelque chose, pas que le modèle l’a bien
  compris (pas de contrôle sémantique de l’implication au-delà des chiffres).
- Les contradictions sont celles signalées par le modèle ; aucune détection
  déterministe des chiffres incompatibles n’est faite.
- L’URL du serveur d’inférence est commune à tous les ΞAgents ; seul le modèle
  est propre à chacun.
- Les contrôles de rédaction sont lexicaux (chiffres, citations, marqueurs
  d’attribution et de prudence) ; la cohérence fine repose sur la relecture du
  modèle local. Une reformulation qui change le sens sans chiffre ni citation
  peut donc passer : la relecture humaine des brouillons reste nécessaire.
- Le résumé de la publication n’a pas de section de sources propre ; il est
  contrôlé contre l’ensemble des citations.
- Une modification manuelle n’est pas réévaluée par le modèle.
- Le plafond d’alertes et la règle « une publication par actualité et par
  semaine » s’appuient sur `watch_decision` : perdre la base les réinitialise
  (les plafonds réels, eux, viennent des fichiers Markdown).
- La détection de publication équivalente est lexicale (72 h) : une même
  information très reformulée, hors de la même actualité, peut passer.
- Un bilan hebdomadaire est publié aux fenêtres suivantes (lundi au plus tôt),
  le temps de rédiger ses brouillons.
- Le mode autonome n’a été exercé qu’avec des données fictives et un modèle
  simulé ; le service n’est pas installé sur le Raspberry Pi.
