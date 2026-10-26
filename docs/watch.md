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
  format:                   # facultatif : surcharges des limites globales (voir « Limites de publication »)
    maxPostChars: 260
  weeklyReview: true        # facultatif ; absent = bilan hebdomadaire actif
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

## Calendriers, orchestrateur et historique d’exécution

Chaque ΞAgent déployé par le nouveau parcours possède deux calendriers
(clé de premier niveau `schedule` du fichier `generators/<handle>/index.md`,
schéma `src/lib/xiagents/schedule.ts`) : **veille** et **publication**. Ce sont
des permissions : hors calendrier, rien ne démarre ; dans le calendrier, l’agent
ne travaille que s’il a du travail (le Bloub n’est jamais forcé à `working`).

- **Modèle** : semaine type (lundi d’abord, plusieurs plages par jour) et
  exceptions par date (au plus 400). Minutes 0–1440 ; une fin antérieure ou
  égale au début traverse minuit (00:00–00:00 = 24 h). Les plages qui se
  chevauchent sont fusionnées.
- **Fuseau** : IANA par agent (par défaut celui du navigateur du créateur).
  Heure inexistante (passage à l’heure d’été) : décalée d’une heure ; heure
  répétée (passage à l’heure d’hiver) : première occurrence. Testé pour
  Europe/Paris, America/New_York et Asia/Tokyo (`tests/xiagents-calendar.test.ts`).
- **Agents existants** : sans clé `schedule`, le fonctionnement antérieur est
  conservé (veille continue, publication 03:00–06:00 Europe/Paris, mêmes clés
  de tâches). Un calendrier illisible ferme la veille et la publication.
- **Pause** : clé `pause` (`since`, `resumeAt`, `resumeWith` `now` |
  `catch-up`), lue seulement si `watch.paused`. La reprise programmée est
  appliquée par le worker avec le choix enregistré. Une pause bloque tout,
  exceptions pour événement majeur comprises, et suspend les tâches en cours.
- **Admission** (`src/lib/watch/orchestrator.ts`) : chaque tâche de veille est
  admise au moment où elle démarre (calendrier, autorisation de rattrapage ou
  manuelle, exception pour événement majeur). Refusée : elle reste en attente
  jusqu’à la prochaine ouverture, sans consommer d’essai. Admise : elle doit
  finir avant la fin de plage + tolérance (30 min par défaut) ; au-delà, elle
  est interrompue proprement (étapes déjà persistées) et reprise plus tard.
- **Priorités** : événement majeur 10, manuel 5, ordinaire 0, plus un
  vieillissement d’un point toutes les 6 min (20 au plus) : aucune famine.
  La rédaction d’un candidat déjà accepté (`draft-candidate`) reçoit un bonus
  d’étape de 9 : juste sous un événement majeur frais, devant les évaluations
  en attente. Une réévaluation massive (« Relancer les analyses suspendues »)
  est planifiée en priorité ordinaire ; une relance ciblée reste manuelle (5).
  Le vieillissement s’applique toujours : une évaluation qui attend nettement
  plus longtemps qu’une rédaction passe d’abord, et une rédaction attend au
  plus ~66 min derrière un arriéré, quelle que soit sa taille. Aucune tâche en
  cours n’est interrompue ; la limite de concurrence d’inférence (Ollama) est
  inchangée. Une actualité déjà trop ancienne pour sa voie (`MAX_AGE`) n’est
  ni planifiée en rédaction ni rédigée : le candidat est suspendu avec la
  raison, sans appel au modèle.
- **Rédaction hors calendrier de veille** : un candidat déjà accepté est
  rédigé (et contrôlé) dès qu’il l’est, y compris hors de la plage de veille,
  tant que le ΞAgent est actif et non en pause : un candidat accepté à
  23 h 30 est prêt pour la fenêtre de 03 h–06 h. Collecte, découverte et
  évaluation restent limitées à la plage de veille ; la fenêtre de
  publication, les plafonds, l’âge maximal, la limite d’inférence et les
  restrictions de visibilité sont inchangés.
  Concurrence : `XI_WATCH_CONCURRENCY` tâches par passage (2 par défaut) et
  `XI_INFERENCE_CONCURRENCY` tâches d’inférence simultanées tous processus
  confondus (1 par défaut, pour ne pas saturer le modèle local).
- **Erreurs** : indisponibilité de l’inférence → attente sans essai consommé ;
  erreurs permanentes (données invalides, configuration refusée, adresse
  bloquée) → échec définitif immédiat ; autres → essais avec backoff
  exponentiel. Chaque tentative est journalisée ; les agents sont isolés.
- **Rattrapage** : si le worker n’est pas passé depuis plus de 30 min, chaque
  agent en marche reçoit une autorisation de veille couvrant les plages
  manquées, bornée par sa limite (72 h par défaut) et par sa date de création,
  pour 1 à 6 h. Clé idempotente : jamais deux rattrapages pour la même panne.
  Le rattrapage ne publie rien d’artificiel : les règles de publication
  s’appliquent normalement.
- **Événements majeurs** (désactivés par défaut) : hors calendrier, collecte
  légère ; seules les informations confirmées par au moins deux sources
  indépendantes dans les 6 dernières heures, au seuil d’alerte, sont évaluées
  (3 par heure au plus) ; la justification est consignée dans la décision.
- **Historique d’exécution** (`xiagent_run`) : agent, type, déclencheur
  (calendrier, manuel, rattrapage, événement majeur), début, fin, statut,
  tentative, résultat, erreur, journal. Distinct de l’historique des
  déploiements. Conservation : réglage de l’agent, sinon
  `XI_RUN_RETENTION_DAYS` (30 jours) ; les publications, leurs sources, les
  candidats et décisions éditoriales ne sont pas purgés par cette rétention.
- **Commandes manuelles** (`POST /api/xiagents/<id>/control`) : pause, reprise
  (maintenant ou avec rattrapage), « Lancer une veille » (collecte immédiate et
  autorisation d’1 h), « Relancer l’analyse » (une actualité, `task:
  "reanalyze"`, ou tous les candidats suspendus, `task: "reanalyze-held"`),
  « Préparer une publication » (brouillon privé à relire). Elles ne changent
  jamais le mode et ne publient jamais hors des règles. Une analyse n’est pas
  relancée si une publication ou un brouillon existe pour l’actualité, ou si
  une évaluation est déjà planifiée ; relancée, elle repart de la première
  étape avec le prompt courant.
- **Migration / retour arrière** : tables `xiagent_run` et `xiagent_grant`,
  colonne `watch_job.priority` (ajoutées automatiquement, aussi par
  `scripts/migrate-auth.ts`). Une version antérieure ignore ces éléments et les
  clés `schedule`, `pause`, `profile` du fichier de l’agent.

## Scheduler (fonctionnement antérieur)

- Fenêtre 03:00–06:00, Europe/Paris, avec changements d’heure (calcul par
  `Intl`, testé sur les nuits de mars et d’octobre). Avec un calendrier de
  publication explicite, les fenêtres suivent ce calendrier
  (`publication-window:<agent>:<date>@HH:MM`).
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
- `claim` prend la tâche due de plus haute priorité vieillie (puis la plus ancienne) en `BEGIN IMMEDIATE`, avec un bail et
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

- Le statut est la **décision de confiance globale** (voir « Matrice de
  confiance ») : `proposed` = en attente, `approved` = approuvée, `rejected` =
  refusée. Les sources en attente et approuvées sont collectées ; refusées,
  désactivées ou supprimées, jamais.
- Transitions : proposée → approuvée ou refusée ; approuvée ou désactivée →
  refusée ; approuvée, refusée ou désactivée → en attente (`reset`, consigné
  comme `updated` avec `changes: { status: proposed }` pour rester lisible par
  une version antérieure) ; approuvée ou en attente → désactivée (collecte
  arrêtée ; confiance globale « en attente » pendant ce temps) ; désactivée →
  réactivée (`enable` : retour à l’état d’avant la désactivation, consigné
  `approved` ou `updated` + `status: proposed`) ; suppression depuis tout état. Chaque décision est ajoutée à `history`
  (date, auteur, note, champs modifiés). Révision optimiste (409).
- La suppression garde une pierre tombale : la source disparaît des listes et
  n’est jamais reproposée par la découverte, l’historique reste lisible dans le
  fichier. Ce n’est pas un refus : seul le propriétaire, en rajoutant l’adresse
  à la main, la rétablit (même identifiant, en attente, historique conservé ;
  ses décisions par ΞAgent ou topic, conservées, s’appliquent de nouveau). Une
  source refusée rajoutée reste refusée (signalée comme déjà connue).
- Suppression et pipeline : elle ne planifie aucune tâche et ne rouvre aucun
  candidat ; ses articles déjà collectés ne servent plus de preuve (source hors
  catalogue = refusée) ; un brouillon qui la cite est retiré au moment de
  publier ; publications, candidats, affirmations et historiques sont gardés.
- Un fichier invalide est ignoré (jamais collecté) et compté dans le diagnostic.
- Découverte par l’agent, une fois par jour : domaines liés par au moins deux
  sources approuvées pour lui sur l’un de ses topics dans la semaine (par leur source d’origine,
  pas par un flux qui les relaie), absents du catalogue. Le site est analysé
  (`<link rel="alternate">`), le flux doit être valide et non vide. Trois
  propositions par jour au plus, aucune au-delà de vingt en attente.

API (session, Origin, propriétaire seulement, sinon 404) :
`POST /api/xiagents/<id>/sources` `{ url, api? }` propose une source pour les
topics de l’agent ; `POST /api/watch/sources` `{ url, topicIds }` ajoute une
source à la main (adresse normalisée : `https://` ajouté, fragment et
paramètres de suivi retirés, http(s) sans identifiants ; doublon reconnu par
flux ou site avant toute requête → `{ duplicate: true, source }` ; topics suivis
par les ΞAgents du propriétaire) ; `GET /api/watch/sources/<id>` fiche complète
(source, historique, collecteur et dernières collectes, décisions et confiance
effective par ΞAgent et topic, 20 derniers articles ; valeurs absentes = `null`,
jamais estimées) ; `POST /api/watch/sources/<id>`
`{ action: approve|reject|reset|disable|enable|delete|update, revision, note?, edits? }`
(topics des modifications : suivis par les ΞAgents ou déjà ceux de la source).

Pages : `/dashboard/sources` (liste, « Ajouter une source », nom → fiche) et
`/dashboard/sources/<id>` (identité, collecte, confiance globale et par
ΞAgent/topic avec révocation, métadonnées, actualités, historique, suppression
confirmée explicitement).

## Matrice de confiance

Page `/dashboard/sources` (navigation « Sources »), propriétaire seulement :
une liste verticale à deux colonnes, **Source** (éditeur, domaine, provenance :
découverte par un ΞAgent ou ajoutée à la main) et **Niveau de confiance**
(sélecteur Approuvée / En attente / Refusée). Au-dessus : filtre ΞAgent (« Tous
les ΞAgents » par défaut), recherche par nom ou domaine, filtre d’état.

- « Tous les ΞAgents » : le sélecteur règle la **décision globale** ; la ligne
  signale les décisions spécifiques existantes (« 1 décision spécifique »).
- Un ΞAgent choisi : le sélecteur affiche la confiance que cet agent résout et
  règle **sa propre décision**, jamais la globale. L’origine est indiquée
  discrètement : globale, spécifique à l’agent, héritée d’un topic, variable
  selon le topic, ou refus global prioritaire (dit aussi après l’enregistrement).
- Bouton « Périmètre » : boîte de dialogue listant toutes les décisions de la
  source (global, chaque ΞAgent, chaque topic suivi), chacune modifiable ; la
  fermeture rend le focus au bouton.

- **Décisions** : global = statut du fichier source (historique, auteur, date,
  révision optimiste) ; ΞAgent et topic = table `watch_source_trust` (`owner`,
  `source_id`, `scope` `agent`|`topic`, `scope_id`, `decision`
  `approved`|`denied`, `decided_by`, `decided_at`). Aucune ligne = en attente.
- **Résolution** pour une actualité et un ΞAgent (`src/lib/watch/trust.ts`) :
  un refus global, de l’agent ou du **topic retenu pour l’actualité** l’emporte ;
  sinon une approbation à l’un de ces niveaux ; sinon en attente. Avant le choix
  du topic (pertinence), seuls les niveaux global et agent s’appliquent. Un
  article relayé par plusieurs flux prend la meilleure confiance de ses flux
  non refusés.
- **Accessibilité** : sélecteurs natifs avec libellé complet (source et
  périmètre) et origine liée par `aria-describedby` ; icône et mot pour chaque
  état (jamais la couleur seule) ; annonces dans une région `aria-live`.
- **API** : `GET /api/watch/trust` (matrice) ; `POST /api/watch/trust`
  `{ sourceId, scope: global|agent|topic, scopeId, decision:
  approved|denied|pending, revision? }` (révision exigée pour le global).
  Session et Origin vérifiées ; source, ΞAgent ou topic d’un autre propriétaire
  (ou topic non suivi) : 404. Répéter la valeur actuelle ne change rien.

Effets dans le pipeline :
- **En attente** : collectée et analysée ; affirmations et résultats conservés
  (statut `pending-trust`), mais rien n’est établi sans au moins une source
  approuvée : une source en attente ne justifie jamais seule une publication.
  Elle peut corroborer une source approuvée (deux voix indépendantes).
- **Approuvée** : source de référence dans son périmètre. Une source
  institutionnelle approuvée est primaire pour ses propres actes et
  déclarations, attribués explicitement ; une affirmation générale reste une
  seule voix tant qu’elle n’est pas corroborée.
- **Refusée** : ses articles ne sont plus montrés au modèle ni comptés comme
  preuve dans le périmètre ; une citation tirée d’eux est écartée. Elle n’est
  plus reproposée (la découverte ignore tout domaine déjà au catalogue).
  Réhabilitation : remettre la cellule en attente ou l’approuver.
- **Réévaluation contrôlée** : chaque changement planifie au plus une tâche
  `evaluate-story` (`recheck: true`) par candidat concerné : actualité récente
  (72 h), portant un article de la source, dans le périmètre modifié, à la
  version évaluée, en attente, retenu ou rejeté après extraction, sans
  brouillon. La tâche suit le calendrier de veille et rejoue les étapes
  enregistrées : seule la vérification (code) est refaite, l’extraction n’est
  redemandée que si les articles utilisables ont changé. Brouillons et
  publications ne sont jamais rouverts ; un brouillon est revérifié au moment
  de publier (ci-dessous). Aucune publication n’est déclenchée par la matrice.

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

Chaque tâche d’évaluation et de rédaction utilise le modèle **résolu pour son
ΞAgent** (détails : [llm.md](llm.md)) : choix explicite de l’agent (autre
modèle ou autre instance Ollama), sinon configuration globale du propriétaire
(Paramètres → Intelligence artificielle), sinon serveur de l’installation
(`XI_INFERENCE_URL`), sinon problème explicite. Jamais de repli silencieux vers
une autre instance, un autre modèle ou un autre fournisseur. Instance, modèle et
options (température, limite de génération, contexte, délai) sont ceux de la
résolution ; le modèle utilisé est enregistré sur le candidat, le brouillon
(`model`, `llm_instance`) et le résultat de l’exécution.

Problèmes et échecs dans l’historique d’exécution :
- configuration (aucune instance, instance supprimée ou désactivée, aucun
  modèle) : tâche en attente 1 h, motif et code affichés, aucune requête ;
- serveur indisponible, délai, mémoire insuffisante : attente 15 min sans
  consommer de tentative ;
- réponse invalide ou contexte trop grand : tentatives bornées (backoff), puis
  exécution **en échec** (jamais « terminée ») et candidat mis de côté ; aucun
  brouillon, aucune publication.

Serveur de l’installation (compatibilité) : `XI_INFERENCE_URL` (ex.
`http://mac-mini.lan:11434`), `XI_INFERENCE_API` (`ollama` par défaut, ou
`openai` pour llama.cpp, LM Studio, MLX…), `XI_INFERENCE_MODEL` (modèle par
défaut), `XI_INFERENCE_TIMEOUT_MS` (180 s par défaut, 10 min au plus),
`XI_INFERENCE_ALLOW` (adresses IP explicites supplémentaires, jamais des noms).

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
   - confiance (matrice) : une citation d’une source refusée pour l’agent et le
     topic retenu est écartée ; sans aucune source approuvée parmi ses
     citations, l’affirmation est `pending-trust` (analysée, jamais établie) ;
   - voix indépendantes = lignées de la collecte (même dépêche, agence,
     éditeur ou groupe = une voix) : 2 voix = corroboré, 1 = une seule voix ;
   - une source officielle approuvée est primaire pour ses propres actes et
     déclarations (attribution à elle-même), et une voix ordinaire pour le reste ;
     une affirmation dont toutes les citations valides viennent de la seule
     publication d’une institution officielle approuvée (ex. : un communiqué
     sur nasa.gov) est son annonce : le code la requalifie en déclaration
     attribuée à cette institution, statut `primary`, sans seconde source ; ce
     n’est jamais un fait nu ni une corroboration (une voix), et la rédaction
     doit nommer l’institution. Une déclaration d’une autre personne citée
     dans ce texte reste attribuée à cette personne. Le prompt d’extraction
     (veille-3.3) signale ces publications officielles au modèle ;
   - hypothèses et interprétations ne deviennent jamais des faits ;
   - les citations ne sont prises que dans le corps de l’article, sans ses
     lignes de métadonnées (signature, auteur, crédits, dates) ; le titre est
     montré au modèle mais n’est jamais citable ;
   - une contradiction signalée met le candidat en attente seulement si le
     modèle la classe « incompatible » (et non redondance, reformulation,
     aspects compatibles ou absence de preuve) avec une position par
     affirmation, et si le code confirme sa structure : affirmations
     distinctes, factuelles ou attribuées, toutes étayées par une citation
     valide, de formulations et de positions différentes, sans passage cité
     en commun. Les autres signalements sont écartés (motif conservé dans
     l’étape) sans toucher aux affirmations.
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

## Limites de publication

Globales par compte (Paramètres → Publications, table `publication_format`,
`GET`/`PATCH /api/publishing/format` avec révision optimiste), surchargeables par
ΞAgent (clé `watch.format`, section « Publications » de sa page ; champ vide =
limite globale). Le serveur valide chaque valeur et la cohérence du résultat
fusionné (minimum ≤ maximum, cible ≤ longueur maximale) ; des limites
incohérentes empêchent toute rédaction, avec la raison.

| Paramètre | Clé | Défaut |
|---|---|---|
| Longueur maximale d’un post | `maxPostChars` | 280 |
| Longueur maximale d’un message de thread | `maxThreadMessageChars` | 280 |
| Messages par thread (min / max) | `minThreadMessages` / `maxThreadMessages` | 2 / 10 |
| Longueur cible d’un post (consigne seulement) | `targetPostMin` / `targetPostMax` | 180–250 |
| Génération de threads | `threads` | activée |
| Choix automatique post/thread | `autoFormat` | activé |
| Tentatives de correction du format | `correctionAttempts` | 2 |

- Les longueurs comptent la prose rédigée (points de code Unicode), sans la
  section `## Sources` ajoutée par Ξ ; chaque message d’un thread est contrôlé
  individuellement. Aucun texte n’est jamais tronqué : le dépassement mesuré est
  renvoyé au modèle pour reformulation (1 + `correctionAttempts` essais), puis le
  candidat passe en attente avec la raison (échec explicite, aucun brouillon).
- Format : le modèle choisit post, thread (sans remplissage, jamais plus de
  messages que d’affirmations) ou **aucun contenu** (`{"format": "none"}` :
  information insuffisante, redondante ou non pertinente ; verdict conservé, non
  redemandé). Threads ou choix automatique désactivés : le circuit autonome ne
  rédige que des posts ; un thread demandé explicitement est refusé si les threads
  sont désactivés.
- Les limites sont revérifiées sur le texte du brouillon au moment de publier
  (abandon, candidat en attente si elles ont été resserrées depuis) et lors de la
  relecture (modification ou approbation au-delà : refusée, 422).
- Les échecs de rédaction (essais, problèmes, refus du modèle), les tâches de
  rédaction en échec et le journal des décisions sont affichés dans la section
  « Publications ».

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
- **Bilan hebdomadaire** (dimanche, aucune publication réelle depuis 7 jours ; désactivable par agent, `weeklyReview: false`) :
  les candidats vérifiés restés sous le seuil nocturne et d’importance ≥ 0,25
  sont retenus, chacun pour sa propre publication (un post, un sujet), puis
  rédigés et publiés aux fenêtres suivantes. Sans matière : aucun bilan.
- **Contrôles au moment de publier** : configuration de l’agent relue
  (pause, désactivation, mode autonome, visibilité) ; actualité non obsolète
  (6 h pour une alerte, 36 h pour la nuit, 8 jours pour le bilan) et inchangée
  depuis la rédaction (sinon réévaluée) ; chaque citation toujours présente
  dans son article ; chaque article porté par une source non refusée pour
  l’agent et le topic retenu (sinon brouillon retiré, candidat en attente ;
  reporté si ses sources échouent durablement) ; chaque affirmation établie
  encore appuyée par une source approuvée (sinon reporté : jamais publié sur la
  seule foi de sources en attente) ; affirmations toujours
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
2. **Évaluation et brouillons** : ajouter l’instance Ollama dans Paramètres →
   Intelligence artificielle (ou `XI_INFERENCE_URL`), choisir le modèle par
   défaut, éventuellement un autre modèle ou une autre instance pour l’agent. Relire candidats, faits,
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
`watch_job`, `watch_host`, `watch_source_state`, `watch_source_trust`
(décisions de confiance par ΞAgent et par topic, jamais purgées), `watch_fetch_log` (100 entrées
par source), `watch_item`, `watch_item_seen`, `watch_story`, `watch_candidate`
et `watch_claim` (30 jours après leur dernière mise à jour), `watch_decision`
(90 jours) et `watch_worker` (dernier passage, dernière erreur). L’index des
publications passe en version 6 (colonne `test_content`) : il est reconstruit
automatiquement depuis le Markdown.

## Exploitation sur le Raspberry Pi

Migration (crée aussi `watch_job`) : `npm run db:migrate`. Passe manuelle :
`npm run watch:tick` ; la sortie ne contient que des compteurs.

Réévaluation manuelle : `npm run --silent watch:reevaluate -- <handle|id>
[storyId]` relance un candidat, ou tous les candidats `held` de l’ΞAgent, par la
commande du propriétaire (ligne `manual-reanalyze(-held)` de l’historique, état
précédent conservé), puis n’exécute que leurs évaluations (`evaluate-story`,
déclenchement `manual`). Aucun gestionnaire de rédaction ni de publication
n’est chargé ; un candidat `accepted` suit ensuite le pipeline normal aux
passages suivants. Sortie : statuts, motifs et version de prompt obtenus.

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
en bout (sources en attente et approuvées, jamais refusées, doublons, histoires, erreurs et reprise,
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
Confiance (`watch-trust.test.ts`) : résolution (refus prioritaire, héritage,
absence de décision), approbations globale, par agent et par topic, refus
l’emportant sur une approbation héritée, révocation et changement, isolation
entre propriétaires, vérification (source en attente analysée mais
insuffisante seule, source refusée exclue, annonce institutionnelle attribuée,
affirmation non corroborée non vérifiée), pipeline avec réévaluation unique
sans nouvel appel au modèle, réextraction après un refus, réhabilitation, aucun
brouillon ni publication, brouillon jamais rouvert. `sources-browser.test.ts` :
la liste (décision globale par défaut, décision d’agent sans écraser la
globale, refus global prioritaire, héritage d’un topic, dialogue de périmètre au
clavier et retour du focus, recherche, filtre d’état).
`test:xiagents:pages` couvre en HTTP l’API de la matrice (session, Origin,
isolation, périmètres étrangers), l’API de politique, les propositions
refusées par la protection SSRF (127.0.0.1, métadonnées cloud, ports, `file:`),
l’isolation et les décisions sur les sources ; `test:xiagents:e2e` le panneau
(activation, pause, proposition refusée, approbation, historique, suppression).

## Limites connues

- Matrice de confiance : un article relayé par plusieurs flux prend la meilleure
  confiance de ses flux non refusés (un agrégateur approuvé peut donc porter
  l’article d’un éditeur refusé). Seules les sources institutionnelles
  approuvées sont primaires pour leurs propres annonces. Les sources refusées
  par un ΞAgent ou un topic seulement restent collectées pour les autres. Le
  déploiement YAML n’écrit que des décisions globales (une source exclue est
  refusée pour tous les ΞAgents).
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
- Les contradictions partent du signalement du modèle : le code écarte celles
  qui sont mal formées, non étayées ou équivalentes, mais ne détecte pas seul
  des chiffres incompatibles, et une contradiction réelle sans verdict
  « incompatible » est ignorée.
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


### Pourquoi un candidat n’est pas publié

`pnpm watch:explain <agent>` (lecture seule) et le panneau de veille du ΞAgent
indiquent pour chaque candidat l’étape où il s’arrête : évaluation (raison et
bilan de ses affirmations : une seule voix, sans citation valide, source en
attente…), rédaction (voie hebdomadaire, tâche échouée ou planifiée) ou
publication (interrupteurs de l’opérateur `XI_WATCH_AUTOPUBLISH*`, mode
autonome du ΞAgent, visibilité publique non confirmée, prochaine fenêtre).
Les candidats retenus avant une correction se relancent avec
`pnpm watch:reevaluate <agent>` (commande du propriétaire, historisée).

### Journaux du worker

`npm run watch:tick` émet immédiatement les événements JSON ligne par ligne sur
`stderr` : démarrage et configuration effective, début/fin des tâches, décisions
éditoriales, appels LLM et résumé lisible de fin de passe. Le bilan JSON existant
reste seul sur `stdout` du worker. Pour supprimer aussi la bannière npm lors d’une
redirection : `npm run --silent watch:tick > bilan.json 2> veille.log`.
Les mêmes lignes sont consultables avec `journalctl` sous systemd.

`XI_WATCH_LOG_LEVEL=debug|info|warn|error` règle le seuil (`info` par défaut,
y compris pour une valeur invalide). `debug` inclut les tâches différées avant
admission. Les appels longs émettent `llm.heartbeat` toutes les 30 secondes avec
`durationMs` et `timeoutMs`, le délai du modèle effectivement résolu. Les timers
sont nettoyés à la fin, à l’échec et à l’interruption de la tâche ; l’observation
ne change ni le délai du client, ni les baux, ni les règles de reprise.

Chaque événement d’inférence (`llm.start`, `llm.heartbeat`, `llm.end`) porte l’étape
éditoriale (`stage` : `relevance`, `merge`, `novelty`, `extraction`, `draft`,
`consistency`) et la limite de génération effective (`maxTokens`). Un échec ajoute :

| Champ | Contenu |
|---|---|
| `errorType` | classe de l’erreur (`InferenceOutputError`, `InferenceUnavailableError`…, sinon `other`) |
| `errorCode` | code Ξ (`timeout`, `unreachable`, `interrupted`, `truncated`, `invalid-json`, `schema`, `http`…) |
| `errorKind` | `timeout`, `network`, `truncated` (limite de tokens atteinte), `invalid-json`, `schema` (validation Zod), `invalid-response`, `server`, `config`, `other` |
| `message` | message fixe de Ξ (jamais le texte du serveur ni du modèle ; URL masquées) |
| `cause` | chaîne de codes techniques, par exemple `network>ECONNRESET` |

`llm.rejected` signale chaque réponse refusée par `askJson` avant le nouvel essai :
`invalid-json` (aucun objet JSON lisible) ou `schema`, avec au plus cinq chemins Zod
(`issues`, par exemple `claims.3.evidence.0.quote: too_big`), sans les valeurs.
`task.end` d’une tâche en échec reprend `errorType`, `errorCode`, `errorKind` et `cause`.

Diagnostic d’un `llm.end` en échec après 90 à 100 s sur le Pi : `errorKind:
"truncated"` signifie que la réponse a atteint `num_predict` ; ce n’est ni un délai
ni le réseau. Chaque étape reçoit au moins le budget que son format de réponse
exige (`src/lib/watch/stages.ts`) : pertinence 512, même événement 384, nouveauté 768,
extraction 2 048 (jusqu’à 12 affirmations avec citations exactes), rédaction 1 536,
relecture 512. Un `maxTokens` configuré plus bas est relevé pour l’étape concernée,
un `maxTokens` plus haut est conservé. Une erreur d’inférence, quelle qu’elle soit,
n’est jamais une validation : la tâche attend ou réessaie, puis l’actualité est mise
en attente avec la raison.

Les références de tâche, ΞAgent, source et actualité sont des empreintes SHA-256
tronquées à 16 caractères, stables pour corréler les événements sans exposer les
identifiants bruts. Les noms de modèles sont limités aux tags techniques ; aucun
nom d’instance, propriétaire, URL, titre, prompt, réponse LLM, justification
éditoriale ou message d’erreur brut (serveur, modèle, exception étrangère à Ξ) n’est journalisé. Les décisions utilisent les
statuts `accepted`, `rejected`, `held` (en attente), `drafted` et `published`, ainsi
que les statuts de fusion, sélection et report existants.
