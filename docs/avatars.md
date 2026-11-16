# Avatars Bloub

Bloub représente toutes les identités. Le rendu SVG et les animations proviennent
exclusivement de la bibliothèque `bloub-react` (MIT, version exacte épinglée),
via la couche générique `src/lib/bloub` et `src/components/bloub` (voir le
README du module). Aucun service externe ni IA.

Une seed aléatoire de 128 bits, unique en base, est attribuée à chaque compte
humain. `bloubFromSeed` en déduit une forme et une expression des catalogues de
la bibliothèque ; la forme utilise le même octet que l’ancien moteur, donc une
seed garde sa silhouette. Les couleurs aléatoires de l’ancien moteur ne sont pas
reprises : le MVP impose un corps noir et des yeux blancs. Les avatars humains
sont des images fixes (aucune boucle d’animation).

Dans `/dashboard/settings`, « Régénérer » ne modifie que l’aperçu ; « Enregistrer » confirme la variante. Les avatars utilisent la configuration explicite, puis la seed humaine, puis le Bloub par défaut.

## Avatars des ΞAgents

Chaque ΞAgent a une configuration `{ version: 1, shape, expression, color }`,
validée contre les catalogues de `bloub-react`, stockée sous la clé `bloub` de
`generators/<handle>/index.md` (`config`, `revision`, `updatedAt`, `updatedBy`),
à côté de `editorial` et `watch`, que les autres écrivains préservent. Un agent
sans clé (ou avec une valeur illisible) s’affiche avec la configuration par
défaut. `GET`/`PATCH /api/xiagents/<id>/avatar` : propriétaire uniquement
(404 sinon), Origin exact, révision optimiste (409), champs inconnus refusés.
La couleur est éditable dans l’éditeur, limitée aux teintes qui gardent les yeux blancs lisibles (contraste ≥ 3:1 : encre, brun, rouge, bleu, violet, rose ; `src/lib/bloub/colors.ts`). Encre (noir) reste la couleur par défaut ; une couleur déjà enregistrée hors de cette liste est conservée et signalée.

Un avatar affiché comme identité (profils, publications, conversations, graphe,
listes d’agents, en-tête et éditeur de la page de gestion) est toujours neutre
(`idle`), avec la forme et l’expression enregistrées : l’activité réelle n’est
pas une photo de profil.

Quatre états universels, non personnalisables, restent calculés côté serveur à
chaque rendu (`lib/xiagents/avatar.ts`, champ `bloub.activity` des auteurs) et
traduits par `lib/bloub/state-mapping.ts`. Ils sont réservés au futur widget
ΞAgents de la sidebar (non implémenté) ; la page de gestion indique l’état réel
en texte, et l’éditeur permet de prévisualiser les quatre états.

| État | Condition | Rendu |
|---|---|---|
| `unavailable` | agent inactif ou configuration éditoriale absente | corps triangulaire, yeux ouverts, fixe |
| `working` | un job de veille de l’agent est réclamé (bail non expiré) | yeux qui parcourent trois points, animé |
| `idle` | veille activée et non en pause | yeux ouverts, fixes |
| `sleeping` | veille désactivée ou en pause | paupières fermées, fixe |

`bloub-react` n’a ni état « yeux fermés » ni « yeux occupés ». Les paupières
fermées sont une image figée pendant le premier clignement du moteur, quand
l’œil est réduit à 14 % de sa hauteur (fermé à 100 %, il devient un trait
sous-pixel effacé par le masque), sur les yeux larges, de face et non inclinés
de l’expression `surpris` : deux traits horizontaux nets, comme l’œil fermé du
`wink` de la bibliothèque. Les yeux occupés sont un `gaze` scripté. Seul
`working` anime, et uniquement à l’écran, onglet visible, sans
prefers-reduced-motion (sinon une image fixe distincte). Le rendu serveur et
l’hydratation utilisent toujours l’image fixe.

La page de gestion du ΞAgent propose un éditeur inspiré du studio : formes,
expressions, test des quatre états (sans effet sur l’état réel), séquences de
démonstration (ajout, ordre, durées, lecture, pause), suivi du curseur et export
SVG de l’image courante. Les séquences ne sont pas enregistrées.

## Stockage, compatibilité et vérification

La session Better Auth identifie le propriétaire. `user_avatar` conserve la seed et la révision ; `PATCH /api/account/avatar` accepte `{seed, revision}`, exige une session et une origine valides et refuse les conflits de révision ou de seed. Les anciennes colonnes `user.image` et `user_avatar.mode`, les triggers de compatibilité et les fichiers `data/avatars` restent en place. Les anciens modes photo utilisent désormais leur seed sans modifier les données. Les photos ne sont plus servies ni modifiées par Xi.

Pour revenir à une ancienne version, conserver ensemble la base et le dossier historique `avatars`. Un enregistrement explicite d’une nouvelle seed choisit le mode Bloub ; les données photo elles-mêmes restent intactes. Aucune migration destructive n’est effectuée.

`pnpm test:avatars` couvre notamment le rendu, les priorités, le fallback et la compatibilité des données. Après un build, `pnpm test:avatars:e2e` vérifie les identités et leur persistance dans un environnement temporaire.
