# Konstruktor — créer à partir d'une idée

Entrée « Créer à partir d'une idée » de la page Konstruktor (`/dashboard/konstruktor/idea`).

1. L'utilisateur décrit librement son intention.
2. **Génération** : tâche système `plan-idea` de Konstruktor (`src/lib/konstruktor/idea.ts`), sur la file habituelle
   (`POST /api/system-agents/konstruktor/tasks`, suivie par son `requestId`), avec le modèle local de l'utilisateur.
   Le modèle ne reçoit **que l'intention** : ni le catalogue de topics, ni les ΞAgents existants (voir « Pourquoi »).
   Il répond en JSON validé : les topics utiles à l'intention (pas de quota : peu pour une demande simple, davantage
   pour une demande vaste ; 10 au plus, limite technique d'un déploiement et d'une réponse de petit modèle), chacun
   rattaché à un domaine ; un domaine = un ΞAgent. Le nombre de domaines vient du regroupement. Pour chaque ΞAgent :
   `agent` = nom inventé (identité courte et prononçable), `description` = mission ; le handle en est dérivé. Seuls les
   **noms** des ΞAgents existants sont donnés au modèle, comme noms pris à éviter (jamais leurs topics ni de références). Contrôles déterministes (`answerProblems`) : topic explicite, quel que soit son
   nombre de mots : « Comètes » ou « Production d'hydrogène » acceptés ; refusé seulement s'il n'est fait que de mots
   manifestement génériques, d'une courte liste (« Science », « Recherche et innovation »), sujets distincts, domaines cohérents ; nom
   d'ΞAgent court (1 à 3 mots), qui ne soit pas une simple description (tous ses mots déjà dans le domaine ou les
   topics), distinct des autres et des ΞAgents existants, sans préfixe ni suffixe commun à tous. Un
   problème → une seule correction demandée au modèle avec la liste des problèmes, puis erreur lisible. JSON illisible →
   une relance, puis erreur.
3. **Réutilisation**, décidée par le code seul, contre le catalogue visible et les ΞAgents de l'utilisateur. Dans le
   doute, on propose du neuf :
   - topic réutilisé seulement s'il **est** le topic proposé : même étiquette, alias ou nom (accents, casse, pluriel
     ignorés), et lui-même explicite (un mot précis comme « Comètes » suffit ; « science » n'est jamais réutilisé). Un mot générique commun (« science », « recherche ») ne suffit jamais ;
   - ΞAgent réutilisé seulement s'il **suit déjà** un topic réutilisé du groupe (le plus de topics en commun ; égalité →
     nouvel ΞAgent). Un nom identique ne suffit jamais : un homonyme est signalé, pas réutilisé ;
   - deux topics de la proposition qui reviennent au même → le second est écarté (note affichée) ;
   - handle pris → suffixe `-2`, `-3`…
4. **Organisation parmi les ΞAgents existants** (étape « Analyse des ΞAgents existants », après la génération, qui
   reste aveugle au catalogue). Pour chaque groupe sans ΞAgent déterminé à l'étape 3 :
   - **candidats** (`candidates`) : les ΞAgents de l'utilisateur dont la mission (description + périmètre, sans les
     exclusions types) ou les topics précis suivis partagent un mot de sujet avec le groupe (mots génériques, de
     fonction et le nom de l'ΞAgent ignorés ; même mot au pluriel ou au genre près, ou mêmes 6 premières lettres).
     C'est un filtre, pas une décision. Aucun candidat → pas d'appel au modèle ;
   - **un seul appel groupé** (`buildMatchPrompt`) : groupes `G1…` et candidats `A1…` avec mission, topics suivis et
     place dans la hiérarchie ; aucun identifiant. Le modèle choisit `attach`, `specialize` (avec le nom de la
     spécialisation) ou `new`, avec une raison ;
   - **vérification** (`checkPlacements`) : seul un candidat **de ce groupe** est accepté ; `specialize` exige un nom
     (1 à 3 mots) et au moins deux topics (un seul topic → rattachement) ; un ΞAgent déjà au niveau maximal reçoit la
     spécialisation sous son ancêtre le plus proche qui le permet (à l'utilisateur), sinon nouvel ΞAgent. Réponse
     inexploitable (après une relance de format) → nouveaux ΞAgents, note affichée, la génération n'échoue pas ;
   - **sous-agent** = mécanisme existant des générateurs pointés (`docs/graph.md`) : handle `parent.specialite`, nom
     « Parent Spécialité », sa mission et ses topics. Profondeur calculée sur la hiérarchie réelle (`hierarchy`,
     même règle que le graphe : ancêtre existant le plus proche par préfixe pointé), jamais en comptant les points ;
     `IDEA_MAX_SUBAGENT_DEPTH = 1` (racine → sous-agent), seule valeur à changer pour aller plus profond ;
   - plusieurs groupes rangés sur le même ΞAgent (ou le même sous-agent) → un seul groupe, un seul déploiement.

   Priorité : un ΞAgent qui suit déjà les topics réutilisés (étape 3) > choix vérifié du modèle > nouvel ΞAgent.
5. **Prévisualisation** par ΞAgent : « ΞAgent existant, réutilisé », « Nouveau sous-agent » (avec son parent) ou
   « Nouvel ΞAgent racine », avec la raison de chaque rattachement ou spécialisation, topics « à créer », « existant », « déjà
   suivi », problèmes bloquants (`draftIssues`). La tâche n'écrit rien.
6. **Confirmation** (`POST /api/konstruktor/ideas {requestId}` → `createFromIdea`) : le plan est relu côté serveur depuis
   le résultat de la tâche de l'utilisateur (jamais envoyé par le client). Un **déploiement par ΞAgent**, avec
   l'identifiant fixé à la prévisualisation :
   - nouveau ΞAgent : brouillon de création standard (`newDraft` → `draftToSpec`) ; pour un sous-agent, le parent est
     revérifié à ce moment (`subAgentProblem` : toujours à l'utilisateur, même handle, profondeur permise), sinon ce
     groupe échoue (409, « régénérez ») sans rien écrire ;
   - ΞAgent existant : modification (`draftToEditSpec`) qui ajoute seulement ses topics manquants ; rien à ajouter →
     `unchanged`.

   Le préflight des déploiements revérifie tout avant d'écrire (étiquettes, handles, révisions). Un groupe en échec
   n'empêche pas les autres ; confirmer à nouveau reprend les déploiements non terminés, sans doublon.

Limites du MVP : pas d'édition du plan (régénérer pour changer), pas de hiérarchie de topics, filtre de candidats
lexical (un ΞAgent dont la mission emploie d'autres mots que le groupe n'est pas proposé ; un mot commun peut en
proposer un hors sujet, que le modèle doit alors écarter), un sous-agent hérite des réglages par défaut et non de ceux
de son parent, ΞAgents créés avec le
premier preset et les réglages par défaut (modifiables ensuite dans leur configuration).

## Pipeline visible

La page affiche les étapes de la tâche (`idea-steps.ts`) : analyse de l'intention, génération locale et regroupement,
analyse des ΞAgents existants (candidats et décisions journalisés), validation des correspondances, prévisualisation disponible. Chaque étape est journalisée (début, fin) dans
l'historique de la tentative (`xiagent_run`) au moment où elle se produit, avec chaque appel au modèle et sa durée ;
la page les relit avec la tâche. Une étape n'est « terminée » que si sa fin est journalisée, la dernière que si le
résultat est enregistré. Temps écoulé réel, aucun pourcentage. L'identifiant de la demande est gardé dans l'adresse
(`?request=`) : après rechargement la page reprend le suivi, sans jamais relancer la génération.

**Délai** : chaque appel au modèle de cette tâche a au moins 15 min (`IDEA_MIN_TIMEOUT_MS`, option `minTimeoutMs` du
binding), les autres opérations gardent leur délai configuré (180 s par défaut). Un dépassement termine la tâche avec
une explication, sans relance automatique par la file.

## Pourquoi le modèle ne voit plus l'existant

Première version : le catalogue (60 topics) et les ΞAgents étaient listés dans le prompt avec des références `T…`/`A…`,
et toute référence renvoyée était acceptée. Sur un vrai test, qwen3:1.7b a rempli ces références au hasard (Astronoxi →
« science », @politiks → « informatique », un nouvel ΞAgent → le topic de l'avion X-59), et le nom proposé était
remplacé par celui du topic existant, ce qui masquait l'écart. La réutilisation est désormais déterministe et le prompt
est plus court : 87 à 104 s au lieu de 4 à 12 min sur qwen3:1.7b. Le prompt ne contient plus d'exemple concret de bon
topic ni de formule qui ressemble à un sujet : le modèle les recopiait (« production d'hydrogène vert », « veille
éditoriale » dans une demande sur la médecine).
