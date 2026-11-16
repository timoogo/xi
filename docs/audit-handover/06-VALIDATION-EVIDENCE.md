# Préparation des vérifications — phase 4, V1

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Relevé statique du 6 novembre 2026. **Aucun test, build, lint, typecheck, worker ni migration exécuté par l'auditeur.** Les résultats CI historiques sont séparés dans `work/evidence/phase-1-H2-github.md` ; ils ne sont pas des résultats V2.

## Commandes disponibles et niveau d'isolation connu

Source officielle : `package.json` et `.github/workflows/ci.yml`. Le tableau décrit des effets possibles et non une certification exhaustive de chaque test. Ne pas exécuter les commandes hors script sur les données réelles sans examen supplémentaire.

| Commandes | Effets / prérequis | Décision V1 |
| --- | --- | --- |
| `pnpm lint` | ESLint lit les fichiers et dépendances ; pas de base ou service métier prévu. | Inclus dans la copie isolée. |
| `pnpm exec tsc --noEmit` | TypeScript ; `incremental` activé dans `tsconfig.json` peut écrire un cache ; les types Next générés dépendent de l'environnement. | Inclus avec `--incremental false` dans la copie ; types générés absents possibles. |
| `pnpm test:publications`, `test:graph`, `test:topics`, `test:xiagents`, `test:accounts`, `test:avatars`, `test:llm`, `test:watch` | Regroupements de fichiers multiples. Nombreux tests créent bases et vaults temporaires ; certains lancent des sous-processus, des serveurs locaux, ou des scripts. `test:watch` inclut des simulations de publication et `tests/migration-copy.test.ts` appelle `npx` ; `test:graph` appelle des scripts. Quelques tests LLM ouvrent de faux serveurs loopback. Les effets de toutes les dépendances n'ont pas été certifiés. | Groupes complets exclus ; cinq fichiers ciblés et vérifiés statiquement inclus. Les autres restent à auditer/isol­er avant lancement. |
| `pnpm build` | `next build` produit `.next` et lit la configuration ; `src/app/layout.tsx:2` importe `next/font/google`, susceptible de contacter Google. | Exclu : effet réseau possible ; build et types générés non vérifiés. |
| `pnpm test:auth`, `test:xiagents:pages` | Démarrent Next après build ; `tests/helpers/next-server.ts:26` crée base/vault temporaires, choisit un port local et exécute des migrations sur cette base. | Exclus : nécessitent build et démarrent des processus et des migrations de test. |
| `pnpm test:e2e`, `test:topics:e2e`, `test:xiagents:e2e`, `test:accounts:e2e`, `test:avatars:e2e` | Chrome/Playwright, serveur local, build et base/vault temporaires ; certains tests démarrent de faux serveurs ; diagnostics peuvent contenir captures, URL, journaux et arbre du vault de test (`tests/helpers/diagnostics.ts:9`). | Exclus ; navigateur et isolation globale non vérifiés. |
| `pnpm db:migrate`, `db:migration-check`, `instance:owner`, `graph:reindex`, `topics:reindex` | Scripts d'administration ; plusieurs chargent `.env.local` et modifient base ou index. Le contrôle de migration vise une copie mais copie les données indiquées. | Exclus ; ce ne sont pas des tests sûrs sur le projet réel. |
| `pnpm dev`, `dev:web`, `dev:worker`, `start`, `watch:tick`, `watch:reevaluate`, `watch:explain` | Serveur/worker et opérations de veille ; `dev:worker` charge `.env.local`, `watch-dev` force l'autorisation opérateur d'autopublication privée. Collecte et publication possibles selon configuration. | Exclus. |

Il n'existe pas de script `test` ou `typecheck` global dans le manifeste. Les commandes des suites ci-dessus se lisent avec le préfixe `pnpm` ; les variantes `:e2e` et `:pages` sont distinctes. `prototypes/v0-xiagent/package.json` déclare `dev`, `build`, `start`, sans suite de tests ; son build est exclu. Ne pas installer les dépendances dans le cadre de V1.

## Sélection exécutée par l'utilisateur

Le script `run-safe-checks.sh` prépare une copie à partir de **l'arbre Git exact**, sans `.env.local`, données ignorées ni modifications non commitées. Il installe une seule fois les dépendances dans la copie avec `pnpm install --frozen-lockfile --ignore-scripts --store-dir <temporaire>`, puis utilise directement les binaires installés dans cette copie. Une recherche ciblée des cinq fichiers retenus ne montre pas d'appel réseau ou accès à des données réelles ; `tests/watch-format.test.ts:42` ouvre SQLite `:memory:`. Les URL présentes dans les fixtures Markdown ou suggestions sont des chaînes de test, pas des appels observés.

Commandes lancées dans la copie, dans cet ordre :

```bash
pnpm install --frozen-lockfile --ignore-scripts --store-dir <répertoire-temporaire>/store
./node_modules/.bin/eslint .
./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/tsx --tsconfig tests/tsconfig.json --test tests/conversation.test.ts tests/markdown-view.test.tsx tests/xiagents-suggest.test.ts tests/watch-format.test.ts tests/bloub-avatar.test.tsx
```

Cette sélection est volontairement limitée : elle ne valide ni base réelle, ni API, ni navigateur, ni LLM réel, ni pipeline complet. Le script ne crée pas de sandbox réseau système ; les dépendances et outils installés sont supposés fiables et pourraient avoir des effets non identifiés. L’installation peut télécharger des paquets depuis le registre ; aucun appel externe n’est requis intentionnellement pour les vérifications incluses. Il ne lance pas le build, qui pourrait télécharger des polices.

Prérequis observés sur la machine au relevé : Node `v26.12.1`, pnpm `11.21.0`, `node_modules` présent. Le projet exige Node `>=22.13.0` et pnpm `11.21.0` ; la CI utilise Node 24 : un échec sur Node 26 peut avoir une cause d'environnement. Le script vérifie `git`, `tar`, `node`, `pnpm`, `mktemp` et `tee`, puis installe les dépendances une seule fois dans la copie. Aucun `node_modules` du dépôt original n’est réutilisé. Il stoppe si HEAD diffère de la référence. Les modifications suivies non commitées ne sont **pas** incluses dans la copie ; leur existence est enregistrée dans le statut Git avant/après.

Chaque commande reçoit uniquement un environnement construit via `env -i` : `PATH` conservé, `HOME`, `TMPDIR`, cache XDG et magasin pnpm jetables ; `CI=1`, `NEXT_TELEMETRY_DISABLED=1`, `COREPACK_ENABLE_NETWORK=0` ; base et vault sous le répertoire temporaire ; secret Better Auth jetable et URL loopback ; `XI_WATCH_DISABLED=true`, drapeaux autopublication `false`. Les variables et secrets du shell ou des fichiers `.env*` du projet réel ne sont pas transmis. La copie issue de `git archive` contient `.env.example` mais pas `.env.local` (`git ls-files '.env*'`). Le secret indiqué par le script est public et réservé aux tests.

Pour les suites exclues, la CI utilise aussi `AUTH_DATABASE_PATH`, `XI_VAULT_PATH`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_TELEMETRY_DISABLED`; le helper serveur remplace ces valeurs par une base/vault temporaires et un secret aléatoire (`tests/helpers/next-server.ts:26`). Les tests navigateur utilisent éventuellement `XI_E2E_CHROME` et `XI_E2E_ARTIFACTS`, et `NEXT_DIST_DIR` peut modifier le répertoire de build. Ceci ne rend pas automatiquement chaque suite sûre sur le dépôt réel.

## Lancement et collecte

Depuis la racine du dépôt :

```bash
bash docs/audit-handover/run-safe-checks.sh
```

Le script affiche le chemin du répertoire `docs/audit-handover/work/logs/v1-.../`, contenant sorties séparées, commande exacte, `results.tsv` (codes et durées) et statuts Git. Il interrompt les vérifications si l’installation échoue ; après installation, il poursuit après un échec et renvoie `1` si une commande ou l’enregistrement de son journal échoue ; prérequis ou référence incorrects renvoient `2`. Il conserve aussi sa copie sous `/tmp` pour inspection, sans suppression automatique. Les logs contiennent potentiellement des chemins locaux ou détails de tests : les relire avant partage. Si une commande est interrompue ou qu'une préparation échoue, des résultats peuvent manquer ; ne pas interpréter une absence comme un succès.

La syntaxe du script corrigé a été contrôlée avec `bash -n` seulement ; ni installation ni vérification n’ont été relancées par l’auditeur. Les résultats utilisateurs devront être analysés, y compris skips, échecs et différence entre la copie et la CI, avant toute qualification.

## Incident et scripts de cycle de vie

Le lancement utilisateur `work/logs/v1-20261106-200552-W7BNUD/` a produit le code 1 pour les trois commandes, toutes interrompues par `ERR_PNPM_UNSAFE_MODULES_DIR` avant exécution d'ESLint, TypeScript et des tests. Il s'agit d'un échec de l'environnement de validation, pas d'un résultat de test Xi. Les journaux et l'ancienne copie sont conservés.

Les manifestes des dépendances installées localement ont été examinés en lecture : `esbuild@0.28.2` déclare `postinstall: node install.js`, `sharp@0.34.5` déclare `install: node install/check.js || npm run build`, `unrs-resolver@1.12.2` déclare `postinstall: node postinstall.js`. `better-sqlite3@13.0.3` n'a pas de script install explicite dans son manifeste observé, mais reste un module natif et `tests/watch-format.test.ts` utilise SQLite en mémoire. `pnpm-workspace.yaml` autorise les builds de better-sqlite3, sharp et unrs-resolver, refuse celui d'esbuild ; `--ignore-scripts` empêche ici **tous** les scripts de cycle de vie, même ceux autorisés par le projet. La compatibilité des binaires précompilés et de tsx/esbuild sans postinstall dépend de la plateforme et n'a pas été vérifiée. Si l'installation ou une vérification signale un binaire manquant, conserver l'échec et le journal : ne pas activer les scripts ou désactiver les protections silencieusement. Un examen et une décision séparés seront nécessaires.

L'installation peut contacter le registre ; `env -i` ne transmet pas de variables de proxy ou de configuration privée, ce qui peut provoquer un échec d'accès. Le `PATH` est conservé, les fichiers `.npmrc` du domicile réel et les caches utilisateur ne sont pas intentionnellement réutilisés. Le script ne constitue pas une sandbox système et ne peut pas garantir contre un outil compromis ou une configuration globale de l'installation système. Si l'installation échoue, les trois vérifications sont marquées `NON_EXÉCUTÉ` ; aucun nouveau résultat de test ne doit être inféré.

## Résultats V1 transmis par l'utilisateur — 2026-11-06

Dossier : [`work/logs/v1-20261106-201141-8wHwyT/`](work/logs/v1-20261106-201141-8wHwyT/). `context.txt` indique le commit `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`, copie `/tmp/xi-audit-v1-a1POn5X4/project` ; les statuts Git avant/après montrent uniquement `docs/audit-handover/` non suivi. Les durées sont celles mesurées par le script ; aucune version Node/pnpm n'est enregistrée dans ce dossier, celles relevées antérieurement ne prouvent pas la version utilisée au lancement.

- Installation `pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/xi-audit-v1-a1POn5X4/store` : code **0**, 7 s, `install.log`. Scripts désactivés ; téléchargement de paquets indiqué dans le journal.
- Lint `./node_modules/.bin/eslint .` : code **0**, 7 s, `lint.log` ; **0 erreur, 3 avertissements** dans le prototype : `xi-dashboard.tsx:4` (`Clock3` inutilisé) et `xi-workspace.tsx:12,38` (`CircleHelp`, `candidates` inutilisés).
- Typecheck `./node_modules/.bin/tsc --noEmit --incremental false` : code **0**, 9 s, `typecheck.log` vide ; exécuté sur la copie sans types Next générés au préalable, selon son `tsconfig`.
- Tests `./node_modules/.bin/tsx --tsconfig tests/tsconfig.json --test` et les cinq fichiers listés dans `results.tsv` : code **0**, 4 s ; rapport Node `tests-cibles.log` : **25 tests, 25 réussis, 0 échec, 0 annulé, 0 ignoré, 0 todo**, 3 529,56 ms durée rapportée par le runner. Les tests couvrent calculs/rendu ciblés et SQLite en mémoire ; aucun parcours navigateur, serveur Next ou LLM réel n'a été exercé.

Ces résultats proviennent de l'exécution utilisateur ; l'auditeur n'a relancé aucune vérification. Le premier lancement bloqué par pnpm reste documenté comme incident d'environnement. Aucun statut de fonctionnalité n'est automatiquement modifié.

## Préparation V2 — 83 fichiers restants

Le détail fichier par fichier et les limites de la classification sont dans [`work/evidence/phase-4-V2-test-matrix.md`](work/evidence/phase-4-V2-test-matrix.md). Sur 88 fichiers suivis, 5 ont été exécutés en V1 ; sur les **83 restants**, le script V2 inclut **20** fichiers : 9 calcul/rendu et 11 tests de stockage temporaire. Les 63 autres sont différés. Les 11 tests retenus utilisent dans leur code examiné `mkdtemp` sous `TMPDIR` et SQLite `:memory:` ou fichier dans le répertoire temporaire ; ils peuvent écrire, supprimer et publier des fixtures dans leur vault temporaire. `TMPDIR` et les chemins de la base et du vault sont imposés sous une copie vierge ; les tests ne doivent pas recevoir les données de l'utilisateur. Le script ne crée toutefois pas une sandbox système : un défaut d'un outil, d'une dépendance ou d'un helper non détecté reste possible. Les outils et la provenance des paquets restent une frontière de confiance.

Catégories reportées dans la matrice : calcul/rendu, SQLite et vault temporaires, serveurs locaux ou sous-processus, navigateur et Next, LLM/flux simulés ou réseau à approfondir. Les étiquettes « probable » sont des indices de code, non des garanties : plusieurs fichiers importent des helpers et croisent plusieurs catégories. Les tests différés ne sont pas tous dangereux ; ils requièrent une inspection supplémentaire de leurs effets avant inclusion. Aucun LLM ou service externe réel n'est configuré dans V2.

### Build et polices

`src/app/layout.tsx:2` importe `Geist` et `Geist_Mono` via `next/font/google`. Le code Next installé `node_modules/next/dist/compiled/@next/font/dist/google/fetch-css-from-google-fonts.js` montre qu'en l'absence de `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`, le chargeur récupère le CSS Google ; `fetch-font-file.js` peut ensuite récupérer les polices. La version présente prend en charge une variable interne de réponses simulées, avec un fichier indexé par URL exacte et des fichiers de police locaux ou octets simulés. C'est une piste pour un build de test, **pas une preuve qu'un build de ce projet fonctionne hors ligne** : elle n'a pas été exécutée, dépend d'une API interne et remplacerait les polices réelles. Aucun `.woff` ou `.woff2` suivi n'a été identifié dans `public/`. Le build est donc exclu de V2, ainsi que les tests nécessitant `next start` et les E2E Chrome.

### Exécution proposée à l'utilisateur

```bash
bash docs/audit-handover/run-v2-checks.sh
```

Le script vérifie le SHA, archive les fichiers suivis du commit dans une nouvelle copie sous `/tmp`, conserve `HOME`, `TMPDIR`, cache et magasin pnpm séparés, et réalise une installation unique `pnpm install --frozen-lockfile --ignore-scripts` avant les deux groupes de tests, un fichier à la fois. L'installation peut accéder au registre ; les tests sélectionnés ne requièrent pas intentionnellement de service externe. Les dépendances ne viennent pas du `node_modules` du dépôt original. Les scripts de cycle de vie sont désactivés ; l'éventuelle absence d'un binaire natif restera un échec visible. Aucun build, navigateur, worker réel ou migration sur les données de l'utilisateur n'est lancé intentionnellement.

Le chemin des logs est affiché ; `results.tsv`, `.command.txt`, `.log` et les statuts Git y sont conservés. Le script continue entre groupes après un échec ; il retourne 1 en cas d'échec et indique `NON_EXÉCUTÉ` si l'installation échoue. Il conserve la copie temporaire et ne nettoie pas les anciennes. Il n'a pas été exécuté par l'auditeur ; seule sa syntaxe `bash -n` a été vérifiée. Après exécution, fournir le chemin du dossier de logs ; les succès devront être analysés par test et par portée avant toute qualification.

## Résultats V2 transmis par l'utilisateur — 2026-11-06

Dossier : [`work/logs/v2-20261106-202249-jSwYBH/`](work/logs/v2-20261106-202249-jSwYBH/). Le contexte indique le commit `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`, copie `/tmp/xi-audit-v2-NbO8J4Lz/project`. Les statuts Git avant/après montrent uniquement `docs/audit-handover/` non suivi ; ils ne couvrent pas les données ignorées. La version Node de l'exécution n'a pas été enregistrée ; le log d'installation indique pnpm 11.21.0.

- **Installation isolée** : `pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/xi-audit-v2-NbO8J4Lz/store`, code **0**, 34 s. Le journal montre le téléchargement de paquets et aucun script de cycle de vie lancé intentionnellement.
- **Calcul et rendu** : commande exacte et neuf fichiers dans `results.tsv` et `tests-calcul-et-rendu.command.txt`, code **0**, 6 s. `tests-calcul-et-rendu.log` : **50 tests réussis**, 0 échec, 0 annulé, 0 ignoré, 0 todo ; durée runner 6 197,92 ms. Les tests incluent notamment décodage d'avatars, calcul de graphe, calendrier et rendu statique ; ils ne démontrent pas des parcours navigateur.
- **Stockage temporaire** : commande exacte et onze fichiers dans `results.tsv` et `tests-stockage-temporaire.command.txt`, code **0**, 11 s. `tests-stockage-temporaire.log` : **72 tests réussis**, 0 échec, 0 annulé, 0 ignoré, 0 todo ; durée runner 10 357,72 ms. Les tests couvrent notamment des règles de propriété, de visibilité, des index et des relations sur des fixtures et supports temporaires ; leur succès ne démontre pas une isolation complète des APIs ou une tenue sous toutes les pannes réelles.

Total du lancement V2 : **122 tests réussis, 0 échec, 0 ignoré, 0 annulé**, sur 20 fichiers. Avec V1 : **147 tests réussis** au total sur 25 fichiers distincts, sans extrapoler au reste de l'application. Il reste **63 fichiers** hors de ces deux sélections. L'installation et les tests ont été lancés par l'utilisateur, pas par l'auditeur. Aucun build, navigateur, service LLM réel ou pipeline externe complet n'est démontré par ces résultats. Le lint et le typecheck réussis restent les résultats V1 ; ils n'ont pas été relancés en V2.

Les tests apportent des preuves techniques ciblées pour les domaines concernés, à relier individuellement aux fonctionnalités en phase 5. Aucun statut n'est automatiquement promu à VALIDÉE. Les 63 fichiers différés et leurs besoins sont listés dans `work/evidence/phase-4-V2-test-matrix.md` ; leurs effets doivent être examinés avant une éventuelle sélection complémentaire.

## Préparation V3 — 63 fichiers restants

Les résultats V2 sont conservés ci-dessus et dans le checkpoint ; le présent travail n'a pas relancé les tests. Les 63 fichiers non couverts par V1/V2 sont nommés et classés dans [`work/evidence/phase-4-V3-test-matrix.md`](work/evidence/phase-4-V3-test-matrix.md). **32 fichiers** sont retenus : 9 fichiers de stockage/index et reprise, 13 de pipeline et supervision avec doubles, 10 d'agents. Ils utilisent des bases SQLite en mémoire ou dans des répertoires `mkdtemp` et des vaults temporaires ; des scénarios publient effectivement des fixtures dans ces vaults temporaires. Les helpers `tests/helpers/konstruktor.ts` et `tests/helpers/publish-world.ts` créent leurs supports dans `tmpdir` et injectent modèles/flux simulés. `tests/topics.test.ts:177` démarre puis termine son propre processus enfant pour un test de verrou ; il est inclus et cet effet est explicite. Certaines suites modifient leur `process.env` en le redirigeant vers leurs répertoires de test ; chaque fichier est exécuté avec `--test-concurrency=1`.

Les 31 fichiers exclus sont énumérés dans la matrice : 18 navigateur/Chrome, 4 serveur Next sans navigateur, 5 avec serveurs simulés ou transports réseau, 4 avec sous-processus/scripts ou `npx`. Ces groupes peuvent nécessiter SQLite/vault temporaires en plus de leurs autres dépendances ; ils ne sont pas classés dangereux par défaut, seulement non retenus après la vérification actuelle. Aucun modèle ou service externe réel n'est fourni par le script. Les tests simulés ne prouvent pas une intégration à Ollama ou des sources externes.

Commande à lancer par l'utilisateur depuis la racine :

```bash
bash docs/audit-handover/run-v3-checks.sh
```

Comme V2, le script vérifie le SHA, extrait uniquement l'arbre Git audité dans `/tmp`, définit un `HOME`, un `TMPDIR`, un cache, un magasin pnpm, une base et un vault temporaires, et ne charge pas les fichiers `.env` du dépôt initial. Il installe une fois les dépendances par `pnpm install --frozen-lockfile --ignore-scripts --store-dir ...` : cette installation peut contacter le registre. Les trois groupes sont exécutés séparément et séquentiellement ; les commandes, durées, logs et codes de retour sont conservés, et un échec ne devient pas un succès. Si l'installation échoue, les trois groupes sont notés non exécutés. Le code global est non nul en cas d'échec. Les anciennes copies ne sont pas supprimées ; les tests peuvent supprimer leurs propres fixtures temporaires dans `TMPDIR`.

L'isolation repose sur les chemins et l'environnement, **pas sur une sandbox système** : le `PATH`, les outils et paquets constituent une frontière de confiance, et le script ne garantit pas l'absence d'accès par un outil compromis ou un effet caché d'une dépendance. La recherche ciblée dans les 32 fichiers n'a identifié ni chemin absolu vers le dépôt utilisateur ni appel direct à un serveur externe ; les helpers inspectés sont décrits ci-dessus. Les fichiers système et la configuration globale éventuelle des outils ne sont pas confinés. Ne pas présenter cette vérification statique comme une garantie mathématique. Comme en V2, les scripts d'installation de `esbuild`, `sharp` et `unrs-resolver` restent désactivés : toute incompatibilité sera visible dans les logs, sans contournement automatique.

### Build hors ligne — vérification statique complémentaire

Les fonctions de la version Next installée `node_modules/next/dist/compiled/@next/font/dist/google/fetch-css-from-google-fonts.js` et `fetch-font-file.js` lisent `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` avant de contacter Google. Le premier charge une correspondance de **l'URL exacte** vers une réponse CSS ; le second lit un fichier absolu ou renvoie des octets simulés quand cette variable est présente. `get-google-fonts-url.js` construit les URL en fonction des familles et axes ; `find-font-files-in-css.js` extrait les références de polices. Une simulation de réponses et des polices locales pourraient donc permettre une expérience hors ligne, mais modifieraient les ressources réellement construites et reposent sur un mécanisme interne de Next. Aucun essai du build, de la simulation ou de l'absence d'autres accès réseau n'a été réalisé. En conséquence **le build reste exclu** : il n'est pas établi qu'il fonctionne hors ligne, et aucune protection n'a été désactivée.

Seule la syntaxe Bash du script V3 a été vérifiée par l'auditeur ; il n'a pas exécuté le script, l'installation, les tests ou le build. Après exécution utilisateur, relever résultats et skips par groupe et conserver les différences d'environnement avant toute qualification.


## Résultats V3 — exécution utilisateur du 2026-11-06

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. [Journaux V3](work/logs/v3-20261106-203339-gxJ3Bn/) et `results.tsv` : installation isolée code 0, 42 s ; stockage/index 47/47, code 0, 36 s ; pipeline simulé 80/80, code 0, 23 s ; agents 55/55, code 0, 9 s. Aucun échec, annulation ou test ignoré déclaré. Total V3 **182/182**, et V1–V3 **329 tests réussis sur 57 fichiers distincts**. Aucun test relancé par l'auditeur. Les simulations ne démontrent pas les intégrations réelles ; les succès ne qualifient pas automatiquement les fonctionnalités.

Deux logs `ΞAgent deployment step failed` correspondent à des pannes explicitement injectées : pour `sources`, `tests/xiagents-deploy.test.ts:30–32,119–140` injecte « Réseau coupé (simulé). » puis vérifie échec et reprise ; pour `calendars`, `tests/konstruktor-apply.test.ts:174–192` injecte « coupure » après écriture et vérifie la reprise. L'émission est dans `src/lib/xiagents/deployments.ts:172`.

Le log `tests-stockage-et-index.log:30` contient `Publication reconciliation failed TypeError`, juste avant le résultat du test HMR `tests/publication-store-cache.test.ts`. `src/lib/publications/runtime.ts:20–25` n'affiche que le type ; le test manipule des stores et watchers (`tests/publication-store-cache.test.ts:19–39,43–59,91–105`). Aucun TypeError explicitement injecté ni pile n'a été trouvé ; la proximité temporelle ne prouve pas son origine. **Anomalie indéterminée**, ni échec produit démontré ni panne volontaire certifiée. Un diagnostic ciblé dans une copie isolée reste nécessaire.

## Préparation V4 — non exécutée

[Classement des 31 fichiers](work/evidence/phase-4-V4-test-matrix.md) : neuf proposés en deux groupes, cinq réseau simulé et quatre sous-processus ; 22 différés (18 navigateur, quatre Next). Les tests migrent ou publient uniquement des données de fixture dans les chemins examinés. `migration-copy` lance `npx` et des migrations sur copies temporaires ; `npm_config_offline=true` et le namespace réseau interdisent son téléchargement pendant les tests.

```bash
bash docs/audit-handover/run-v4-checks.sh
```

Le script vérifie HEAD, extrait le commit dans une nouvelle copie, crée des chemins temporaires et installe une seule fois avec `pnpm install --frozen-lockfile --ignore-scripts` (registre possiblement contacté). L'installation est sous bubblewrap : racine en lecture seule, dépôt masqué, seule copie temporaire accessible en écriture ; elle conserve le réseau pour le registre. Les groupes de tests sont dans un namespace réseau distinct avec boucle locale activée, dépôt masqué, `/run` isolé et racine en lecture seule. Cette protection dépend de bubblewrap et des namespaces utilisateur/réseau autorisés par le système ; si absents ou refusés, les commandes échouent sans repli. La présence de `bwrap` et `ip` ne prouve pas leur fonctionnement. Des outils système et dépendances restent de confiance et la racine reste lisible hors dépôt ; ce n'est pas une garantie contre une faille du noyau ou une compromission privilégiée. Les anciennes copies sont conservées, mais les tests nettoient leurs propres fixtures.

Les scripts de cycle de vie restent désactivés ; incompatibilité native éventuelle visible. Résultats, commandes, durées et codes de `tee` sont conservés. Si l'installation échoue les groupes sont indiqués non exécutés ; si la boucle locale ne peut être activée, le groupe échoue avec 125. Aucun contournement automatique. Le code global est non nul en cas d'échec. Aucun build, navigateur ou test V4 n'a été lancé par l'auditeur. Le build hors ligne et les 22 fichiers exclus restent à traiter séparément.

## Réorientation — audit CI et couverture, 2026-11-06

V4 reste préparé **non exécuté sur décision utilisateur**. Aucun test, build, worker ni migration n'a été lancé par l'auditeur. Commit de référence inchangé. Matrices : [88 fichiers et suites](work/evidence/phase-4-ci-file-matrix.md) et [47 fonctionnalités et tests cités](work/evidence/phase-4-feature-test-matrix.md).

### Workflows et conditions

Un seul workflow suivi : `.github/workflows/ci.yml`. Déclenchement : PR vers `main`, push sur `main`, exécution manuelle. `concurrency` annule le run précédent d'une même PR ou référence ; permissions `contents: read`. Ubuntu 24.04, Node 24, pnpm du manifeste ; installation `pnpm install --frozen-lockfile` **sans** `--ignore-scripts`, contrairement à V1–V3 locaux. Pas de déploiement dans ce workflow.

- **Quality (lint, types)** : `pnpm lint`, `pnpm exec tsc --noEmit`, délai 15 min.
- **Tests (core)** : `test:publications`, `test:accounts`, `test:avatars`, `test:llm`, `test:topics` ; **Tests (graph)** : `test:graph` ; **Tests (agents)** : `test:xiagents`, `test:watch`. Matrice `fail-fast: false`, 15 min par job. La boucle exécute toutes les suites du groupe et sort 1 si une échoue. Chaque étape préalable ou suivante doit réussir ; contrôle Git de l'arbre non ignoré et absence du répertoire `data`, sans prouver l'absence d'autres effets.
- **Build and server tests** : base/vault dans `RUNNER_TEMP`, secret éphémère ; `pnpm build`, `pnpm test:auth`, `pnpm test:xiagents:pages` ; 20 min. Ce build CI historique a réussi avec l'environnement réseau du runner, ce n'est pas une preuve de build hors ligne. `next/font/google` introduit une dépendance potentielle au téléchargement.
- **Browser E2E** : Chrome stable installé, build séparé, puis suites `test:e2e`, `test:topics:e2e`, `test:accounts:e2e`, `test:avatars:e2e`, `test:xiagents:e2e` avec `--test-concurrency=1` ; boucle accumulant les échecs, délai 30 min. Artéfacts diagnostiques en cas d'échec, conservés sept jours si présents. Ce job doit réussir pour un run entièrement vert mais n'est pas un contrôle exigé par le ruleset observé.

Les 15 commandes de tests développées dans `package.json`, y compris le glob `tests/graph-*.test.ts`, sélectionnent **88/88 fichiers suivis recensés** : 66 dans les suites core/graph/agents, quatre dans les tests serveur et 18 dans les suites navigateur ; les catégories sont disjointes. Aucun fichier `.test.ts(x)` suivi ne manque de cette sélection ; cela ne démontre ni couverture des comportements ni que tous les cas sont sans mock. Les 57 fichiers locaux appartiennent à cet ensemble et ne doivent pas être additionnés aux résultats CI comme s'il s'agissait de scénarios distincts.

### Run historique au commit exact

[Run push #4](https://github.com/timoogo/xi/actions/runs/42217743143), SHA exact, six jobs `success`, du 6 novembre 2026. Journaux GitHub consultés : `test:publications` 42, `accounts` 5, `avatars` 14, `llm` 24, `topics` 49, `graph` 50, `xiagents` 111, `watch` 97, `auth` 13, `xiagents:pages` 2 ; E2E : `e2e` 8, `topics:e2e` 4, `accounts:e2e` 1, `avatars:e2e` 1, `xiagents:e2e` 10. Total **431 cas rapportés réussis**, zéro échec, annulation, skip ou todo rapporté dans chacun des 15 résumés. Ce sont des totaux de suites, pas un nombre de fonctionnalités ni nécessairement de cas uniques. L'étape d'upload des diagnostics est ignorée selon sa condition normale d'échec, distincte des skips de tests. Résultats historiques du runner, non tests locaux actuels.

La suite agents CI contient également `Publication reconciliation failed TypeError` dans le job 127891872910, le 6 novembre à 12:27:33 UTC. Le même message existe donc dans deux environnements ; ceci renforce la pertinence d'une investigation mais n'établit ni son origine, ni un défaut utilisateur. `runtime.ts:20–25` masque la pile ; aucune injection explicite de ce TypeError n'a été identifiée. Statut **indéterminé**. Les erreurs de déploiement de V3 correspondent, elles, aux injections documentées plus haut.

### Protection de main : observation distante

Lecture du [ruleset actif Protect main #26676970](https://github.com/timoogo/xi/rules/26676970), via `GET /repos/timoogo/xi/rulesets/26676970` : cible `~DEFAULT_BRANCH`, PR exigée, résolution des conversations exigée, zéro approbation obligatoire, méthodes merge/rebase, protection contre suppression et non-fast-forward, cinq checks obligatoires : `Quality (lint, types)`, `Build and server tests`, `Tests (core)`, `Tests (graph)`, `Tests (agents)` ; politique stricte, `bypass_actors: []`, `current_user_can_bypass: never` pour cette connexion. `Browser E2E` absent de cette liste. `GET /branches/main` indique `protected: true` mais les champs de protection classique affichent `enabled: false` et contrôles désactivés : cela ne contredit pas nécessairement le ruleset séparé. `GET /branches/main/protection` retourne **403**, règles classiques non lisibles. `GET /rules/branches/main` refusé par le connecteur : éventuelles règles héritées et cas de contournement externes non exhaustivement établis. Le ruleset impose une PR aux acteurs concernés ; ne pas généraliser aux administrateurs ou à d'autres accès non visibles, ni déduire qu'une CI verte interdit à elle seule un push. Observation actuelle, pas preuve de sa configuration exacte à chaque intégration passée.

### Lacunes justifiant des vérifications ciblées

1. Diagnostic du TypeError de réconciliation sur copie isolée avec capture contrôlée de la pile, puis scénario de concurrence/HMR si nécessaire ; aucune donnée privée dans les traces.
2. Parcours complet sur données jetables avec instance Ollama réellement locale et source explicitement autorisée : vérifier échecs réseau, provenance et absence de publication involontaire ; les serveurs factices ne suffisent pas.
3. Coupure entre écritures SQLite/vault et reprise ; interruption d'un handler après expiration de bail, avec contrôle d'effets et de déduplication : les tests existants ne prouvent pas l'annulation des opérations encore actives.
4. Validation des frontières d'autorisation sur les chemins HTTP et du lien entre propositions sélectionnées et chaque champ de configuration Konstruktor ; cibler les hypothèses non déjà couvertes, sans rejouer V4 en bloc.
5. Vérifier mode d'exploitation et reprise du worker hors développement ; build hors ligne seulement si exigence produit confirmée.

## Complément de clôture — matrice et protection

La [matrice des 88 fichiers](work/evidence/phase-4-ci-file-matrix.md) indique désormais, pour chaque fichier, sélection locale, commande et job CI, type dominant, dépendances identifiées et raison du report V4. Les catégories distinguent unités, intégration locale, intégration avec doubles, serveur Next et navigateur ; un fichier peut contenir plusieurs types. Le classement dominant ne constitue pas un relevé exhaustif des assertions : les doubles et dépendances transitifs non démontrés restent marqués comme incertains. La [matrice des 47 fonctionnalités](work/evidence/phase-4-feature-test-matrix.md) relie les preuves connues sans transformer un test cité en preuve d'un parcours complet.

Le ruleset `26676970` a été relu : toujours actif sur la branche par défaut, cinq checks exigés et navigateur absent de la liste ; la protection classique renvoie toujours 403 pour la connexion utilisée. La présence de règles héritées ou d'autres exceptions reste indéterminée. V4 reste suspendu. Aucun test supplémentaire exécuté.
