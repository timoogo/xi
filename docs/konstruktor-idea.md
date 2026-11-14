# Konstruktor — créer à partir d'une idée

Entrée « Créer à partir d'une idée » de la page Konstruktor (`/dashboard/konstruktor/idea`).

1. L'utilisateur décrit librement son intention.
2. **Génération** : tâche système `plan-idea` de Konstruktor (`src/lib/konstruktor/idea.ts`), sur la file habituelle
   (`POST /api/system-agents/konstruktor/tasks`, suivie par son `requestId`), avec le modèle local de l'utilisateur.
   Le modèle répond en JSON validé (`ideaAnswerSchema`) : exactement 5 topics distincts, chacun rattaché à un domaine ;
   un domaine = un ΞAgent. Le nombre de domaines vient du regroupement, pas d'un chiffre imposé. Réponse invalide :
   une relance, puis erreur affichée.
3. **Réutilisation et doublons**, décidés par le code et non par le modèle (`planFromAnswer`), contre le catalogue
   visible et les ΞAgents de l'utilisateur seulement :
   - topic de même étiquette, alias ou nom (accents, casse, pluriel ignorés) → topic existant réutilisé ;
   - ΞAgent de même handle ou nom → ΞAgent existant réutilisé ; référence `T…`/`A…` du modèle acceptée sinon ;
   - deux topics de la proposition qui reviennent au même → le second est écarté (note affichée) ;
   - handle pris par quelqu'un d'autre → suffixe `-2`, `-3`…
4. **Prévisualisation** par ΞAgent : nouveau ou existant, topics « à créer », « existant », « déjà suivi », problèmes
   bloquants (`draftIssues`). La tâche n'écrit rien.
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
