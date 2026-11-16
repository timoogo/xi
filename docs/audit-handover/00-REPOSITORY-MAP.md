# Phase 0 — Cartographie du dépôt

Relevé du 6 novembre 2026, sur `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Cette reconnaissance identifie des pistes, pas des fonctionnalités validées.

## Référence et environnement

- Racine : `/home/timogo/dev/labs/xi` ; branche locale `main` ; `origin` : `https://github.com/timoogo/xi.git`.
- `origin/HEAD` pointe vers `origin/main`, à la même révision que HEAD au dernier relevé local. Aucun fetch : l'état actuel du serveur n'est pas certifié.
- Working tree initial propre selon `git status --porcelain=v1 --untracked-files=all` ; fichiers ignorés non inspectés individuellement. Une configuration locale et un répertoire `data/` existent : ne pas les utiliser pour les validations.
- Six branches locales et deux branches distantes effectives connues (`origin/main`, `origin/ci/github-actions`), hors alias `origin/HEAD` ; zéro tag. `git rev-parse --is-shallow-repository` : `false`. Ceci ne garantit pas la présence des références distantes supprimées ou jamais récupérées.
- 61 commits uniques accessibles par `git log --all` ; dates de commit relevées de 2025-07-30 à 2026-11-06. Le HEAD est un merge mentionnant la PR #1 : cela prouve au moins une référence de PR dans Git, pas le nombre total de PR accessibles. `gh pr list --repo timoogo/xi --state all --limit 100 --json number,state,title` n'a pas répondu et a été interrompue ; accès et total des PR indéterminés.

## Mesures et méthode

- `git ls-files` : **537 fichiers suivis**, dont `src/` 353, `tests/` 97, `prototypes/` 28, `docs/` 22, `scripts/` 8, `public/` 10 ; reste à la racine et dans `.github/`.
- Comptage par extension des fichiers suivis : 316 `.ts`, 148 `.tsx`, 24 `.md`, 4 `.mjs`, 2 `.css` ; autres formats : configuration, images et archive. Les extensions TS incluent les déclarations et tous les périmètres.
- Approximation des lignes physiques, par `splitlines()` sur les fichiers suivis `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.css` sous les quatre répertoires suivants, en excluant `.d.ts` : `src/` 351 fichiers / 30 804 lignes ; `scripts/` 8 / 477 ; `tests/` 96 / 17 059 ; `prototypes/` 12 / 487. Total **467 fichiers / 48 827 lignes**, dont **359 fichiers / 31 281 lignes** pour `src/` et `scripts/`. Ce sont des lignes physiques, commentaires et lignes vides compris, pas des instructions ni des lignes fonctionnelles ; ce filtre exclut les fichiers racine, SQL éventuel et autres extensions. Aucun retrait de code généré suivi au-delà des déclarations `.d.ts` ; les éventuels fichiers générés suivis restent à identifier. Dépendances, caches et artefacts non suivis exclus par construction.
- **88 fichiers** suivis `tests/*.test.ts` ou `tests/*.test.tsx` (recherche récursive sous `tests/`) ; le nombre de cas, ceux exécutables et leurs résultats restent inconnus.
- Reproduction : `git ls-files | wc -l`, `git log --all --format='%H' | wc -l`, `git branch --list`, `git branch -r --list`, `git tag -l`. La méthode exacte du comptage de lignes est conservée dans le checkpoint de phase 0.

## Structure et domaines candidats

Les noms ci-dessous justifient une investigation ; ils ne démontrent ni branchement réel, ni complétude, ni fonctionnement :

- `src/app/` : pages, authentification, tableau de bord et routes API ; `src/components/` : interface et composants thématiques.
- `src/lib/accounts`, `server`, `scheme` : comptes, authentification et persistance à tracer ; Better Auth et better-sqlite3 sont déclarés dans `package.json`.
- `src/lib/topics`, `search`, `graph` : Topics, recherche et graphe ; distinctions entre graphe et mémoire collective à établir.
- `src/lib/xiagents`, `system-agents`, `konstruktor` : agents et coordination système ; `tests/` contient des suites homonymes.
- `src/lib/watch`, `arbiter`, `publications` ; `src/components/sources` : veille, sources, arbitrage, rédaction/publication et interactions ; flux à relier.
- `src/lib/llm` : modèles et intégrations ; `src/lib/bloub` : avatars ; `scripts/` : worker et outils ; à relier à la configuration et à l'interface.
- `prototypes/v0-xiagent/` possède son propre `package.json` : prototype séparé à distinguer de l'application principale, sans conclure à son intégration ou abandon.
- `tests/` et `.github/workflows/ci.yml` : validation et infrastructure. `docs/` et `README.md` fournissent des affirmations à confronter au code.

## Outils et commandes déclarées

`package.json` : Next.js 15.4.5, React 19.1.0, Better Auth 1.7.11, better-sqlite3 13.0.3, TypeScript 5, ESLint 9, `tsx`, `playwright-core` ; Node >= 22.13 et `pnpm@11.21.0`. `pnpm-lock.yaml` et `package-lock.json` coexistent ; `pnpm-workspace.yaml` existe mais ne déclare pas de liste de packages. Prototype : `pnpm@12.3.4`, Next 16.4.3 et lockfile séparé. Ne pas déduire un workspace multipackage de la seule présence de ce fichier.

Commandes : `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` ; suites `pnpm test:auth`, `test:publications`, `test:graph`, `test:topics`, `test:xiagents`, `test:xiagents:pages`, `test:accounts`, `test:avatars`, `test:llm`, `test:watch` ; suites navigateur `test:e2e`, `test:topics:e2e`, `test:xiagents:e2e`, `test:accounts:e2e`, `test:avatars:e2e`. Pas de script `typecheck` ni `test` global déclaré. La CI décrit trois groupes de suites, un build, des tests serveur et un job navigateur ; sa configuration n'atteste pas de leurs résultats. Elle fournit au build des chemins temporaires de base et vault ; vérifier les chemins et effets de chaque suite avant exécution locale. Ne pas exécuter les scripts de migration, réindexation, worker ou publication sur les données réelles.
