# Avatars Bloub et photos de profil

Bloub est l’avatar par défaut. Une seed aléatoire de 128 bits, unique en base,
est attribuée à chaque compte. Le moteur SVG local de Bloub détermine la forme,
les couleurs et les yeux depuis cette seed ; aucun service externe ni IA.
La correspondance seed/apparence v1 doit rester stable. Des seeds distinctes
ne constituent pas une garantie mathématique de silhouettes distinctes.

Dans /dashboard/settings, « Régénérer » ne modifie que l’aperçu. « Enregistrer »
confirme la variante ou le choix « Mon Bloub » / « Ma photo ». La photo reste
conservée lors du passage à Bloub. Importer une photo l’active ; la supprimer
rétablit le Bloub enregistré. Le SVG possède un rendu statique côté serveur ;
les animations respectent prefers-reduced-motion et s’arrêtent hors écran.

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

Les tests bloub.test.ts vérifient migration, répétition, anciens écrivains,
préservation des données, unicité des seeds et déterminisme du rendu. Le parcours
navigateur couvre aussi aperçu sans sauvegarde, activation, conservation de la
photo, conflits, persistance après reconnexion et réduction des animations.
