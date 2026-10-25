# Intelligence artificielle : providers LLM

Les ΞAgents analysent, évaluent et rédigent avec des **modèles locaux**. Le seul fournisseur pris en
charge est **Ollama** ; aucun service cloud n'est requis ni utilisé, et il n'existe aucun repli vers
un autre fournisseur.

## Architecture

| Couche | Module | Rôle |
| --- | --- | --- |
| Contrat | `src/lib/llm/types.ts` | Types partagés (client et serveur) : instances, options, sélection par agent, résolution, codes d'erreur. |
| Destination | `src/lib/llm/network.ts` | Validation des URL et politique réseau (voir Sécurité). |
| Client | `src/lib/llm/ollama.ts` | `GET /api/version`, `GET /api/tags`, `POST /api/chat` ; erreurs typées. |
| Inférence | `src/lib/llm/inference.ts` | `Inference` liée à une instance, un modèle et des options. |
| Configuration | `src/lib/llm/store.ts` | Instances et instance par défaut du propriétaire (SQLite). |
| Résolution | `src/lib/llm/resolve.ts` | Quelle instance, quel modèle, quelles options pour un agent. |
| Exécution | `src/lib/llm/server.ts` | Runtime partagé par le serveur web et le worker (`bind`, `check`, `testModel`). |
| Moteur | `src/lib/watch/llm-binding.ts` | Liaison d'un ΞAgent à son modèle pour l'évaluation et la rédaction. |

Les ΞAgents ne connaissent ni URL ni client HTTP : ils référencent une instance par **identifiant
stable**, et toutes les requêtes passent par la résolution puis la liaison.

## Configuration globale

« Global » est **par compte** (Ξ n'a pas d'administration d'instance) : chaque propriétaire gère ses
instances dans **Paramètres → Intelligence artificielle** ; celles d'un autre compte ne sont ni
visibles ni utilisables. Une instance a un nom, une **clé portable** (référence YAML), une URL, un
état activé/désactivé, un modèle par défaut et des paramètres d'inférence par défaut. Les actions
« Tester la connexion » et « Actualiser les modèles » sont explicites (aucune inférence au chargement
d'une page, aucun téléchargement de modèle). La suppression d'une instance utilisée affiche les
ΞAgents concernés et exige un choix : les réaffecter à une autre instance, les remettre en héritage,
ou les laisser en « problème de configuration ».

Le serveur défini par l'opérateur (`XI_INFERENCE_URL`, compatibilité) sert d'instance d'installation
aux propriétaires qui n'ont choisi aucune instance par défaut ; l'interface l'indique.

## Sélection par ΞAgent et héritage

Clé `llm` du fichier de l'agent : `{ instanceId, model, options }`.

| Mode | `instanceId` | `model` | Effet |
| --- | --- | --- | --- |
| Hériter (défaut) | `null` | `null` | Instance et modèle globaux. |
| Autre modèle | `null` | défini | Instance globale, autre modèle installé. |
| Autre instance | défini | facultatif | Cette instance, son modèle par défaut ou celui choisi. |

Priorité : configuration explicite de l'agent → instance par défaut du propriétaire → serveur de
l'installation → **erreur contrôlée** (`not-configured`). Une instance supprimée (`instance-missing`)
ou désactivée (`instance-disabled`), ou l'absence de modèle (`no-model`), est un problème affiché sur la
page de l'agent et dans l'historique d'exécution : jamais de bascule silencieuse vers une autre
instance ni de modèle choisi arbitrairement. Les agents antérieurs (sans clé `llm`) gardent leur
ancienne référence `modelRef` comme choix de modèle sur l'instance globale.

Options : `temperature`, `maxTokens` (`num_predict`), `contextSize` (`num_ctx`), `timeoutMs` ;
valeurs intégrées (température 0, 2 048 jetons, contexte du modèle, 180 s) ← instance ← agent. Le
décodage reste déterministe (graine fixe) pour qu'une tâche reprise ne dérive pas.

## Intégration au moteur

Évaluation (pertinence, même événement, nouveauté, extraction) et rédaction (post ou thread, relecture
de cohérence) utilisent la liaison de l'agent. Le LLM ne décide jamais seul : citations exactes,
indépendance des voix, sources primaires, déduplication, plafonds et contrôles de publication restent
du code déterministe, indépendant du modèle ; un texte généré n'est qu'un brouillon privé soumis à ces
contrôles. Les réponses structurées sont validées par des schémas Zod, avec une nouvelle demande au
plus, puis des tentatives bornées ; aucune réparation ne change le sens d'une réponse.

| Situation | Effet sur la tâche |
| --- | --- |
| Configuration absente ou invalide | Attente 1 h, motif et code dans l'historique, aucune requête. |
| Serveur injoignable, délai, mémoire insuffisante, connexion interrompue | Attente 15 min sans consommer de tentative. |
| URL refusée, modèle non installé | Problème de configuration (attente 1 h). |
| Réponse invalide, contexte trop grand | Tentatives bornées, puis exécution en échec, candidat mis de côté. |

Une inférence obligatoire en échec n'est jamais une exécution « terminée » et ne produit ni brouillon
ni publication. Le modèle et l'instance utilisés sont enregistrés (candidat, brouillon, résultat).

## Endpoints Ollama

- `GET /api/version` : connectivité (ne charge aucun modèle) ;
- `GET /api/tags` : modèles installés (nom, taille, famille, paramètres, quantification ; la taille
  de contexte n'est pas fournie par cet endpoint et reste vide) ;
- `POST /api/chat` (`stream: false`, `format: "json"`, `think: false`) : inférence. Le raisonnement des modèles « thinking » (qwen3…) est désactivé : ses tokens comptent dans `num_predict` et épuiseraient la limite avant la réponse. `message.thinking` n’est jamais utilisé comme réponse ; `done: false` ou `done_reason: "length"` = réponse incomplète, refusée pour du JSON. Le bouton « Tester le modèle » envoie les mêmes options que les exécutions de l’agent (compte ← agent), seul le délai est plafonné à 120 s.

## Sécurité

- Appels **côté serveur uniquement**, vers les instances enregistrées du propriétaire, sur ces seuls
  chemins ; pas de redirection, délais et tailles bornés ; les corps de réponse distants ne sont
  jamais renvoyés tels quels.
- URL http(s) sans identifiants, requête ni fragment. Adresses résolues (et épinglées, sans
  rebinding DNS) : boucle locale, réseaux privés, Tailscale 100.64/10 et IPv6 ULA **autorisés
  volontairement** (un Ollama du réseau local est l'usage visé) ; lien local (métadonnées cloud) et
  adresses publiques refusés, sauf IP listées dans `XI_INFERENCE_ALLOW`.
- `XI_LLM_ALLOWED_HOSTS` (`hôte` ou `hôte:port`, séparés par des virgules) restreint les destinations,
  par exemple sur une installation partagée entre plusieurs comptes.
- Routes réservées au propriétaire (session, contrôle d'Origin), tests et vérifications limités par
  propriétaire : les endpoints ne servent ni de proxy HTTP ni de scanner du réseau local.
- L'export YAML ne contient que la clé portable de l'instance : ni identifiant, ni URL, ni secret.

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `XI_INFERENCE_URL`, `XI_INFERENCE_API`, `XI_INFERENCE_MODEL`, `XI_INFERENCE_TIMEOUT_MS` | Serveur de l'installation (facultatif). |
| `XI_INFERENCE_ALLOW` | IP publiques explicitement autorisées. |
| `XI_LLM_ALLOWED_HOSTS` | Restriction facultative des destinations. |
| `XI_INFERENCE_CONCURRENCY` | Tâches d'inférence simultanées (worker). |

## Tests

`npm run test:llm` : client Ollama simulé, configuration et résolution, intégration au moteur
(`tests/llm-integration.test.ts`), interface. YAML : `tests/xiagents-yaml.test.ts`.
