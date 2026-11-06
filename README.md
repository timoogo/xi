# Ξ (Xi)

Xi est un projet personnel de veille intelligente basé sur [Twitty](https://github.com/Ramy29/Twitty). Le MVP conserve la structure Next.js du dépôt d’origine ; les fonctionnalités de veille IA ne sont pas encore implémentées.

---

## MVP actuel

- Authentification locale Better Auth + SQLite : inscription, connexion et déconnexion.
- Profil privé affichant le nom, l’email, l’avatar et un identifiant dérivé du compte connecté.
- Fil Markdown « Pour vous » et « Abonnements », préférences explicites, conversations et synchronisation SSE.
- Navigation responsive et modes clair/sombre conservés.
- Communautés, notifications, suggestions et topics explicitement indisponibles.

Les données de démonstration Twitty ont été retirées. Les publications Markdown (brouillons, publication, corbeille) sont stockées dans le vault Obsidian : voir le [format et l’architecture des publications](docs/publications.md). Les réponses et abonnements sont implémentés ; les autres interactions sociales et le moteur de veille IA restent hors périmètre. Le [contrat du fil et sa validation](docs/feed.md) précise les comportements et limites actuels. L’[audit des fichiers et du nettoyage](docs/data-cleanup.md) détaille les éléments retirés et conservés.

## Stack

Next.js 15 / React 19, TypeScript, Tailwind CSS, composants Shadcn/UI, React Hook Form, Zod, Better Auth et SQLite locale. Utiliser pnpm pour toutes les commandes.

## Démarrage local

Prérequis : Node.js 22.13 ou plus récent et pnpm. SQLite reste sur le disque local ; aucun service cloud n’est nécessaire. `better-sqlite3` est un pilote natif, autorisé dans `pnpm-workspace.yaml` ; une chaîne de compilation C/C++ peut être nécessaire si aucun binaire précompilé n’est disponible pour votre plateforme.

```bash
pnpm install
cp .env.example .env.local
```

Générer un secret avec `pnpm exec node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, puis le placer dans `.env.local` :

```dotenv
BETTER_AUTH_SECRET=<secret aléatoire généré, au moins 32 caractères>
BETTER_AUTH_URL=http://localhost:3000
AUTH_DATABASE_PATH=./data/xi-auth.sqlite
XI_VAULT_PATH=/home/timogo/Documents/obsiflow-vaults/xi
```

- `BETTER_AUTH_SECRET` signe les sessions : garder sa valeur entre redémarrages, ne pas le publier.
- `BETTER_AUTH_URL` est l’origine de l’application. HTTPS est obligatoire hors localhost. Adapter le port si nécessaire.
- `AUTH_DATABASE_PATH` est le chemin du fichier SQLite (défaut : `./data/xi-auth.sqlite`), relatif au dossier de lancement ou absolu. Conserver ce fichier pour conserver comptes et sessions.
- `XI_VAULT_PATH` est le chemin absolu du vault Obsidian existant. Il doit exister : Xi ne crée que `posts/` à l’intérieur. Le chemin reste côté serveur.
- `.env.local`, le dossier `data` et les fichiers SQLite sont ignorés par Git. Aucun secret n’utilise un préfixe `NEXT_PUBLIC_`.

```bash
pnpm db:migrate
pnpm dev
```

Ouvrir `http://localhost:3000/auth/register`. L’inscription utilise nom, email, mot de passe et confirmation, sans téléphone, et connecte immédiatement le nouveau compte. La connexion suivante utilise seulement email et mot de passe. Les mots de passe sont hachés par Better Auth (scrypt) ; les sessions sont stockées dans SQLite, avec cookies HttpOnly, SameSite=Lax et Secure en HTTPS. Les sessions durent sept jours et sont renouvelées selon les règles Better Auth. La déconnexion révoque la session en base et efface son cookie.

Le middleware effectue une redirection rapide sans cookie ; le layout serveur du tableau de bord vérifie la session en base, y compris si le cookie est falsifié, expiré ou révoqué. Les Server Actions utilisent le plugin officiel `nextCookies` ; les endpoints Better Auth sont servis sous `/api/auth/*`. Les protections d’origine et la limitation de débit Better Auth sont activées. Il n’y a pas encore de vérification d’email ni de récupération de mot de passe par email.

### Initialisation, conservation et retour arrière

`pnpm db:migrate` applique les migrations natives Better Auth aux tables locales (`user`, `account`, `session`, `verification`, `rateLimit`). La commande est répétable, ne supprime pas les comptes et refuse les ajouts de colonnes obligatoires incompatibles avec des données existantes. Exécuter cette commande avant le premier démarrage et après une mise à jour du schéma. Ne pas exécuter plusieurs migrations en parallèle.

Avant une mise à jour, arrêter le serveur et sauvegarder le fichier SQLite ainsi que ses éventuels fichiers `-wal` et `-shm`. Utiliser un disque persistant et une instance Node locale pour ce MVP. Conserver le même secret, la même origine et le même fichier permet de retrouver une session après redémarrage.

Les anciens comptes et cookies `token` de Twitty ne sont pas importés : créer un nouveau compte Xi. Aucun compte externe n’est supprimé. `NEXT_PUBLIC_API` n’est plus utilisé pour l’authentification ; aucun autre appel API n’a été modifié. Pour revenir à l’ancienne version, conserver une sauvegarde SQLite et rétablir le code/configuration de l’API externe ; les comptes locaux ne deviennent pas des comptes Twitty automatiquement.

### Vérifications et mode production local

Arrêter `pnpm dev` avant le build : **ne jamais partager `.next` entre build et dev simultanés**.

```bash
pnpm lint
pnpm build
pnpm exec tsc --noEmit
pnpm test:publications
pnpm test:auth
pnpm test:e2e
pnpm start
```

Si un serveur dev utilise déjà `.next`, isoler les vérifications sans l’arrêter :

```bash
NEXT_DIST_DIR=.next-verify pnpm build
NEXT_DIST_DIR=.next-verify pnpm test:auth
NEXT_DIST_DIR=.next-verify pnpm test:e2e
pnpm test:publications
pnpm exec tsc --noEmit
pnpm lint
```

Le build et les tests doivent utiliser la même valeur `NEXT_DIST_DIR`. Le dossier `.next-verify` est ignoré par Git et ESLint.

`pnpm test:e2e` pilote Chrome (`/usr/bin/google-chrome-stable`, ou `XI_E2E_CHROME`) en mode headless sur le build courant : inscription, écriture, autosave, publication, fil, suppression, annulation, corbeille et restauration avec collision.

`pnpm test:auth` nécessite le build courant. Les tests créent une véritable base SQLite temporaire, appliquent deux fois la migration, démarrent `next start` sur un port libre, appellent les Server Actions référencées par les formulaires et les routes HTTP Better Auth, puis arrêtent et redémarrent le processus. Ils vérifient l’inscription, le hachage, le doublon d’email, le mauvais mot de passe, les cookies falsifiés et expirés, la déconnexion, la protection des pages, le refus d’une origine étrangère et la persistance après redémarrage. La base temporaire est supprimée à la fin ; la base locale de développement n’est pas utilisée.

Les tests vérifient aussi le rendu du compte courant, les états vides et l’isolation de deux utilisateurs authentifiés (requêtes simultanées et paramètres d’URL), sans modifier la base de développement.

### Intégration continue (GitHub Actions)

`.github/workflows/ci.yml` s’exécute sur les Pull Requests vers `main`, les push sur `main` et à la demande (`workflow_dispatch`). Un nouveau push annule le run obsolète de la même PR. Node 24 et pnpm (version fixée par `packageManager` dans `package.json`), dépendances installées avec `pnpm install --frozen-lockfile` et cache pnpm.

| Job | Contenu |
| --- | --- |
| Quality (lint, types) | `pnpm lint`, `pnpm exec tsc --noEmit` |
| Tests (core / graph / agents) | `test:publications accounts avatars llm topics`, `test:graph`, `test:xiagents watch` en parallèle ; chaque suite s’exécute même si une précédente échoue, le job échoue si l’une échoue |
| Build and server tests | `pnpm build`, puis `test:auth` (dont l’arrêt de `next start` avec des flux SSE en cours de connexion et des connexions ouvertes sans requête) et `test:xiagents:pages` sur ce build |
| Browser E2E | Chrome stable installé par `browser-actions/setup-chrome`, `XI_E2E_CHROME` pointant sur son binaire, build, puis `test:e2e`, `test:topics:e2e`, `test:accounts:e2e`, `test:avatars:e2e`, `test:xiagents:e2e`, un fichier à la fois (`--test-concurrency=1`) |

Isolation et sécurité :

- Permissions `contents: read` seulement ; aucun secret, aucun déploiement, aucune publication, aucun push. Le checkout ne conserve pas le jeton GitHub.
- Le build reçoit une configuration jetable : `BETTER_AUTH_SECRET` aléatoire à chaque run, base SQLite et vault dans le dossier temporaire du runner. `data/xi-auth.sqlite` n’est jamais utilisé.
- Les tests créent leurs bases et vaults dans des dossiers `mkdtemp()` ; les serveurs `next start` écoutent sur un port libre de `127.0.0.1` et vident les variables des fichiers `.env*` du projet. Aucun modèle n’est appelé : les tests LLM utilisent des inférences simulées, aucun Ollama ni homelab n’est contacté.
- Chaque job de test vérifie à la fin que l’arbre Git est intact et qu’aucun dossier `data/` n’a été créé.
- Diagnostics E2E : un test navigateur qui échoue écrit, pour chaque page ouverte, une capture pleine page, son URL et son titre, ainsi que la sortie récente du serveur (conservée entre redémarrages) et l’arborescence du vault temporaire, dans `XI_E2E_ARTIFACTS` (par défaut `$TMPDIR/xi-e2e-artifacts`). En CI, ce dossier est publié comme artefact privé `e2e-diagnostics` (7 jours) uniquement en cas d’échec ; il ne contient que des données de test synthétiques.
- `createTestServer().stop()` attend au plus 15 s la fin gracieuse de `next start` (6 s au plus en temps normal) puis échoue explicitement avec la sortie du serveur, au lieu d’un timeout muet du test.
- `SHARP_IGNORE_GLOBAL_LIBVIPS=1` force le binaire précompilé de `sharp`.

Arrêt de `next start` : sur SIGTERM, Next appelle `server.close()`, qui attend toutes les connexions. Node ferme lui-même les connexions keep-alive inactives, mais pas une connexion qui n’a encore rien envoyé (préconnexion d’un navigateur) : il la compte comme une requête en cours et `close()` arrête aussi la vérification de `headersTimeout`. Seul le client pouvait alors libérer l’arrêt (environ 100 s pour Chrome), en test comme en production. `src/instrumentation.ts` suit les connexions acceptées (canal `net.server.socket`) et ferme au signal celles dont le serveur n’a lu aucun octet ; une requête dont les premiers octets sont arrivés est conservée et servie, et les flux SSE suivent leur propre fermeture. Limites : Next écoute 300 à 400 ms avant d’appeler `register()`, donc une connexion muette ouverte dans cette fenêtre de démarrage n’est pas suivie ; des octets encore en transit au moment du signal ne se distinguent pas du silence, comme pour la fermeture des connexions keep-alive inactives par Node.

Le job Browser E2E n’est pas destiné à devenir un check obligatoire tant que sa fiabilité sur GitHub n’est pas établie : les échecs intermittents observés en local sont corrigés : `sources-browser` (focus vérifié avant sa restitution par Radix), `xiagents-browser` (arrêt de `next start` retenu par les préconnexions de Chrome, voir ci-dessous) et `publication-design-browser` (requête de l’image comptée avant que le navigateur ne la charge : `next/image` est en chargement différé, le test attend désormais `decode()`). Les checks obligatoires seront configurés après un premier run réussi, avec les noms réels des jobs.

Validation locale du workflow : `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/ci.yml`.

### Topics hiérarchiques

La page `/dashboard/topics` permet de proposer, confirmer, explorer et gérer les topics partagés, avec pipeline SSE et routage privé corrigible. Les topics restent distincts des comptes éditoriaux. Voir [l’architecture, les permissions et les limites](docs/topics.md). Réindexation : `npm run topics:reindex` ; tests : `npm run test:topics` et `npm run test:topics:e2e`.
