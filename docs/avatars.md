# Avatars Bloub et photos de profil

Bloub est l’avatar par défaut. Le rendu SVG et les animations proviennent
exclusivement de la bibliothèque `bloub-react` (MIT, version exacte épinglée),
via la couche générique `src/lib/bloub` et `src/components/bloub` (voir le
README du module). Aucun service externe ni IA.

Une seed aléatoire de 128 bits, unique en base, est attribuée à chaque compte
humain. `bloubFromSeed` en déduit une forme et une expression des catalogues de
la bibliothèque ; la forme utilise le même octet que l’ancien moteur, donc une
seed garde sa silhouette. Les couleurs aléatoires de l’ancien moteur ne sont pas
reprises : le MVP impose un corps noir et des yeux blancs. Les avatars humains
sont des images fixes (aucune boucle d’animation).

Dans /dashboard/settings, « Régénérer » ne modifie que l’aperçu. « Enregistrer »
confirme la variante ou le choix « Mon Bloub » / « Ma photo ». La photo reste
conservée lors du passage à Bloub. Importer une photo l’active ; la supprimer
rétablit le Bloub enregistré.

## Avatars des ΞAgents

Chaque ΞAgent a une configuration `{ version: 1, shape, expression, color }`,
validée contre les catalogues de `bloub-react`, stockée sous la clé `bloub` de
`generators/<handle>/index.md` (`config`, `revision`, `updatedAt`, `updatedBy`),
à côté de `editorial` et `watch`, que les autres écrivains préservent. Un agent
sans clé (ou avec une valeur illisible) s’affiche avec la configuration par
défaut. `GET`/`PATCH /api/xiagents/<id>/avatar` : propriétaire uniquement
(404 sinon), Origin exact, révision optimiste (409), champs inconnus refusés.
La couleur fait partie du format mais n’est pas éditable dans l’interface.

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

## Stockage et authentification

La session Better Auth identifie exclusivement le propriétaire. Le client
ne peut fournir aucun identifiant de compte à modifier. Le champ existant
user.image contient l’URL de la photo. La table additive user_avatar stocke
la seed, le mode actif et la révision de concurrence.
La navigation, le profil, les publications, les threads, les réponses et le
graphe continuent d’utiliser UserAvatar et les données d’auteur existantes.
La page des paramètres rafraîchit les données serveur après chaque opération.

Les fichiers sont dans le sous-dossier avatars du répertoire contenant
AUTH_DATABASE_PATH (par défaut data/avatars). Ils ne sont pas dans public/.
Sauvegarder ce dossier avec la base d’authentification ; une installation
sur plusieurs machines doit partager la base et ce stockage local.

PUT /api/account/avatar reçoit le fichier brut avec son Content-Type.
DELETE /api/account/avatar retire la photo du compte connecté.
PATCH /api/account/avatar enregistre {seed, mode, revision}. Un conflit de
révision ou de seed renvoie 409 ; un mode photo sans photo est refusé.
Toutes les mutations exigent une session valide et l’Origin exact de BETTER_AUTH_URL.
GET /api/avatars/<uuid>.webp exige une session et ne sert que les fichiers
encore référencés par un compte. Les photos sont visibles par les utilisateurs
authentifiés de Ξ, comme les profils ; les réponses sont privées, sans cache.

## Validation et remplacement

- JPEG, PNG ou WebP non animé uniquement, 5 Mio maximum.
- Limite vérifiée sur les octets reçus, même sans Content-Length.
- Décodage réel par sharp, format cohérent avec le Content-Type,
  maximum 16 mégapixels et délai de traitement borné.
- Orientation EXIF appliquée, recadrage central carré 512 × 512,
  réencodage WebP ; EXIF/GPS et autres métadonnées supprimés.
- Noms UUID générés côté serveur, permissions de dossier 0700/fichier 0600,
  refus des chemins arbitraires et des liens symboliques lors de la lecture.
- Fichier écrit avant de publier l’URL ; transaction SQLite synchrone pour
  remplacer image et updatedAt dans le modèle Better Auth. Ce modèle est
  relu à chaque requête, le cache de cookie étant désactivé.
- Une transaction échouée conserve l’ancienne photo et nettoie la nouvelle.
  Les anciennes photos non référencées sont supprimées après remplacement.
  Le changement d’URL évite de réutiliser une version mise en cache.
- Une panne brutale entre écriture et transaction peut laisser un fichier
  non référencé sur disque ; il n’est pas servi. Une erreur de nettoyage
  est journalisée sans annuler une mise à jour déjà réussie.

sharp 0.34.5, déjà présent via Next.js, est déclaré directement pour rendre
explicite la dépendance de validation d’images. Le lockfile utilisé est pnpm.

## Vérification

pnpm test:avatars couvre les formats, métadonnées, fausses images, animations,
limites de taille et de pixels, ainsi que le dépassement en flux sans longueur.

Après un build de production, pnpm test:avatars:e2e utilise Chrome, deux
comptes et un stockage temporaires : CSRF, accès anonyme, import clavier,
échec de remplacement, affichage dans les différentes vues, persistance
après redémarrage, écritures concurrentes, suppression physique, isolation
des comptes et affichage mobile.

Pour coexister avec next dev, utiliser NEXT_DIST_DIR=.next-verify pour le build
et les tests navigateur. Le projet prend déjà en charge ce dossier séparé.

## Migration et retour arrière

La migration idempotente s’exécute via db:migrate, et au démarrage lorsque
la table Better Auth existe déjà. Elle préserve les photos choisies des comptes
existants (mode photo) et attribue le mode Bloub aux autres. Les triggers
attribuent une seed aux nouvelles inscriptions et synchronisent le mode après
une modification de user.image, y compris depuis un ancien écrivain.
Aucune photo ni donnée existante n’est supprimée par la migration.

Pour revenir à l’ancienne application, conserver user_avatar et ses triggers :
les anciens lecteurs continuent de lire user.image et les anciens écrivains
restent compatibles. Les seeds persistent pour un retour à la nouvelle version.
Sauvegarder la base SQLite et le dossier avatars ensemble avant déploiement.

Les tests bloub.test.ts et bloub-avatar.test.tsx vérifient migration, répétition,
anciens écrivains, préservation des données, unicité des seeds, validation,
sauvegarde des avatars de ΞAgents, états universels et rendu. Le parcours
navigateur couvre aussi aperçu sans sauvegarde, activation, conservation de la
photo, conflits, persistance après reconnexion et réduction des animations.
