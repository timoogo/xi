# Konstruktor — créer à partir d'une idée

Entrée « Créer à partir d'une idée » de la page Konstruktor (`/dashboard/konstruktor/idea`).

1. L'utilisateur décrit librement son intention.
2. **Génération** : tâche système `plan-idea` de Konstruktor (`src/lib/konstruktor/idea.ts`), sur la file habituelle
   (`POST /api/system-agents/konstruktor/tasks`, suivie par son `requestId`), avec le modèle local de l'utilisateur.
   Le modèle ne reçoit **que l'intention** : ni le catalogue de topics, ni les ΞAgents existants (voir « Pourquoi »).
   Il répond en JSON validé : exactement 5 topics, chacun rattaché à un domaine ; un domaine = un ΞAgent. Le nombre de
   domaines vient du regroupement. Contrôles déterministes (`answerProblems`) : topic explicite (au moins deux mots
   porteurs de sens : « production d'hydrogène », pas « production »), sujets distincts, domaines cohérents. Un
   problème → une seule correction demandée au modèle avec la liste des problèmes, puis erreur lisible. JSON illisible →
   une relance, puis erreur.
3. **Réutilisation**, décidée par le code seul, contre le catalogue visible et les ΞAgents de l'utilisateur. Dans le
   doute, on propose du neuf :
   - topic réutilisé seulement s'il **est** le topic proposé : même étiquette, alias ou nom (accents, casse, pluriel
     ignorés), et lui-même explicite. Un mot générique commun (« science », « recherche ») ne suffit jamais ;
   - ΞAgent réutilisé seulement s'il **suit déjà** un topic réutilisé du groupe (le plus de topics en commun ; égalité →
     nouvel ΞAgent). Un nom identique ne suffit jamais : un homonyme est signalé, pas réutilisé ;
   - deux topics de la proposition qui reviennent au même → le second est écarté (note affichée) ;
   - handle pris → suffixe `-2`, `-3`…
4. **Prévisualisation** par ΞAgent avec la raison de chaque réutilisation, topics « à créer », « existant », « déjà
   suivi », problèmes bloquants (`draftIssues`). La tâche n'écrit rien.
5. **Confirmation** (`POST /api/konstruktor/ideas {requestId}` → `createFromIdea`) : le plan est relu côté serveur depuis
   le résultat de la tâche de l'utilisateur (jamais envoyé par le client). Un **déploiement par ΞAgent**, avec
   l'identifiant fixé à la prévisualisation :
   - nouveau ΞAgent : brouillon de création standard (`newDraft` → `draftToSpec`) ;
   - ΞAgent existant : modification (`draftToEditSpec`) qui ajoute seulement ses topics manquants ; rien à ajouter →
     `unchanged`.

   Le préflight des déploiements revérifie tout avant d'écrire (étiquettes, handles, révisions). Un groupe en échec
   n'empêche pas les autres ; confirmer à nouveau reprend les déploiements non terminés, sans doublon.

Limites du MVP : pas d'édition du plan (régénérer pour changer), pas de hiérarchie de topics, ΞAgents créés avec le
premier preset et les réglages par défaut (modifiables ensuite dans leur configuration).

## Pipeline visible

La page affiche les étapes de la tâche (`idea-steps.ts`) : analyse de l'intention, génération locale et regroupement,
validation des correspondances, prévisualisation disponible. Chaque étape est journalisée (début, fin) dans
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
