# Classification V3 des 63 fichiers restants

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2` ; lecture statique et helpers, aucun test exécuté. Les catégories se chevauchent : `setup` et `world` créent des vaults/SQLite temporaires ; les réponses LLM ou flux doublés ne démontrent aucune intégration réelle. Les chemins sont ceux du commit de référence.

## 32 fichiers retenus

Sélection par groupes dans `../../run-v3-checks.sh` ; tous utilisent la copie et TMPDIR isolés. Les tests peuvent créer/effacer des fixtures ou publier dans leurs vaults de test. `topics.test.ts` démarre puis arrête son propre processus enfant pour le verrou. Il ne s’agit pas d’une sandbox système.

- `tests/account-store-cache.test.ts` — vault/SQLite temporaires, variables de processus modifiées vers temporaire.
- `tests/arbiter.test.ts` — vault/SQLite temporaires, helper publication : données/Arbitre simulés.
- `tests/bloub.test.ts` — vault/SQLite temporaires, SQLite mémoire.
- `tests/editorial-queue.test.ts` — vault/SQLite temporaires, helper publication : données/Arbitre simulés.
- `tests/graph-perf.test.ts` — vault/SQLite temporaires.
- `tests/graph-security.test.ts` — vault/SQLite temporaires, SQLite mémoire.
- `tests/integration-pipeline.test.ts` — vault/SQLite temporaires, helper Konstruktor : modèle et flux doublés, fetch injecté simulé, LLM injecté simulé.
- `tests/konstruktor-apply.test.ts` — vault/SQLite temporaires, helper Konstruktor : modèle et flux doublés.
- `tests/konstruktor-suggestions.test.ts` — vault/SQLite temporaires, helper Konstruktor : modèle et flux doublés.
- `tests/konstruktor.test.ts` — vault/SQLite temporaires, helper Konstruktor : modèle et flux doublés.
- `tests/personal-topics.test.ts` — vault/SQLite temporaires, SQLite mémoire.
- `tests/publication-store-cache.test.ts` — vault/SQLite temporaires, variables de processus modifiées vers temporaire.
- `tests/realtime-events.test.ts` — vault/SQLite temporaires, SQLite mémoire.
- `tests/supervision.test.ts` — vault/SQLite temporaires, helper publication : données/Arbitre simulés.
- `tests/system-agent-tasks.test.ts` — vault/SQLite temporaires.
- `tests/topic-discovery.test.ts` — vault/SQLite temporaires, SQLite mémoire.
- `tests/topics.test.ts` — vault/SQLite temporaires, SQLite mémoire, sous-processus de verrou.
- `tests/watch-draft.test.ts` — vault/SQLite temporaires, LLM injecté simulé.
- `tests/watch-publish.test.ts` — vault/SQLite temporaires, helper publication : données/Arbitre simulés.
- `tests/watch-source-admin.test.ts` — vault/SQLite temporaires, fetch injecté simulé.
- `tests/watch-trust.test.ts` — vault/SQLite temporaires, LLM injecté simulé.
- `tests/xiagents-creation.test.ts` — vault/SQLite temporaires, SQLite mémoire, fetch injecté simulé.
- `tests/xiagents-deploy-resume.test.ts` — vault/SQLite temporaires, SQLite mémoire, fetch injecté simulé, variables de processus modifiées vers temporaire.
- `tests/xiagents-deploy.test.ts` — vault/SQLite temporaires, SQLite mémoire, fetch injecté simulé.
- `tests/xiagents-exclusions.test.ts` — vault/SQLite temporaires, SQLite mémoire, fetch injecté simulé.
- `tests/xiagents-generation.test.ts` — vault/SQLite temporaires, LLM injecté simulé.
- `tests/xiagents-handles.test.ts` — vault/SQLite temporaires, SQLite mémoire, fetch injecté simulé.
- `tests/xiagents-orchestrator.test.ts` — vault/SQLite temporaires, SQLite mémoire.
- `tests/xiagents-topic-refs.test.ts` — vault/SQLite temporaires, SQLite mémoire, fetch injecté simulé.
- `tests/xiagents-widget.test.tsx` — vault/SQLite temporaires.
- `tests/xiagents-yaml.test.ts` — vault/SQLite temporaires, SQLite mémoire, fetch injecté simulé.
- `tests/xiagents.test.ts` — vault/SQLite temporaires, SQLite mémoire.

## 31 fichiers exclus et raisons

### Navigateur / Next

Chrome/Playwright et serveur Next : build nécessaire, isolation et effets de tous les helpers non démontrés.

- `tests/accounts-browser.test.ts`
- `tests/arbiter-browser.test.ts`
- `tests/avatars-browser.test.ts`
- `tests/e2e.test.ts`
- `tests/konstruktor-apply-browser.test.ts`
- `tests/konstruktor-browser.test.ts`
- `tests/konstruktor-suggestions-browser.test.ts`
- `tests/publication-design-browser.test.ts`
- `tests/search-browser.test.ts`
- `tests/sources-browser.test.ts`
- `tests/supervision-browser.test.ts`
- `tests/topic-network-browser.test.ts`
- `tests/topics-browser.test.ts`
- `tests/xi-live-browser.test.ts`
- `tests/xiagents-browser.test.ts`
- `tests/xiagents-create-browser.test.ts`
- `tests/xiagents-import-browser.test.ts`
- `tests/xiagents-widget-browser.test.ts`

### Serveur Next sans navigateur

Démarre Next et migre une base temporaire ; build absent, prérequis non satisfaits.

- `tests/auth.test.ts`
- `tests/server-shutdown.test.ts`
- `tests/system-agents-http.test.ts`
- `tests/xiagents-page.test.ts`

### Serveurs simulés / réseau

Ouvre des ports loopback et/ou exerce des transports ; absence de toute sortie externe et effets transverses à vérifier.

- `tests/llm-config.test.ts`
- `tests/llm-integration.test.ts`
- `tests/llm-ollama.test.ts`
- `tests/watch-collect.test.ts`
- `tests/watch-evaluate.test.ts`

### Sous-processus / scripts

Lance scripts, sous-processus ou npx ; effets et éventuel téléchargement à vérifier individuellement.

- `tests/graph-integration.test.ts`
- `tests/migration-copy.test.ts`
- `tests/watch-events.test.ts`
- `tests/watch.test.ts`

Total : 63 fichiers, 32 retenus, 31 exclus. `tests/integration-pipeline.test.ts` injecte un modèle et des réponses RSS simulés ; le succès de ce test n’établit pas le fonctionnement avec Ollama ou des sources réelles. Les groupes exclus ne sont pas déclarés défectueux.
