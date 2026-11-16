# Matrice exhaustive des 88 fichiers de tests

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2` ; sources : workflow, scripts `package.json`, liste `git ls-files`, commandes et journaux V1–V3. Une ligne décrit la catégorie dominante et les dépendances identifiées, pas chaque assertion : certains fichiers combinent unitaires et intégration. I = intégration locale avec composants réels sur fixtures ; IS = intégration avec au moins un double de modèle, fetch ou système ; S = serveur Next réel sur données temporaires ; N = navigateur Chrome + serveur Next ; U = calcul ou rendu isolé. U et IS ne sont pas des intégrations externes réelles ; I/S/N peuvent employer des doubles selon le cas. Une dépendance non identifiée n’est pas exclue. Pas d’intégration réelle à Ollama ou à une source externe établie. Les types IS sont attribués aux cas dont les doubles ont été observés dans les preuves V3/V4 ; autres cas « I » peuvent aussi comporter des doubles non identifiés.

CI : inclusion statique, résultat historique par suite et non preuve d’exécution de chaque assertion ; voir `../../06-VALIDATION-EVIDENCE.md`. La colonne « local » indique la sélection d’un fichier dans un groupe qui a réussi, pas la réussite de chaque branche de code. V4 est suspendu : les 31 fichiers non exécutés localement sont tous reportés ; neuf figuraient dans le script V4, 22 étaient exclus du script (besoin build Next/navigateur). Aucun des 88 fichiers n’est exclu des commandes CI.

| Fichier | Local | Suite CI → job | Type dominant | Dépendances ou doubles identifiés | Report local / V4 |
|---|---|---|---|---|---|
| `tests/account-store-cache.test.ts` | V3 | `test:xiagents` → Tests (agents) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/accounts-browser.test.ts` | non | `test:accounts:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/accounts.test.ts` | V2 | `test:accounts` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/arbiter-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/arbiter.test.ts` | V3 | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/auth.test.ts` | non | `test:auth` → Build and server tests | S | build et serveur Next, SQLite/vault temporaires, loopback | exclu V4 : build Next / navigateur |
| `tests/avatars-browser.test.ts` | non | `test:avatars:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/avatars.test.ts` | V2 | `test:avatars` → Tests (core) | U | Node/tsx, calcul ou rendu; sharp | aucun |
| `tests/bloub-avatar.test.tsx` | V1 | `test:avatars` → Tests (core) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/bloub.test.ts` | V3 | `test:avatars` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/conversation.test.ts` | V1 | `test:publications` → Tests (core) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/e2e.test.ts` | non | `test:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/editorial-queue.test.ts` | V3 | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/feed.test.ts` | V2 | `test:publications` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/graph-engine.test.ts` | V2 | `test:graph` → Tests (graph) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/graph-index.test.ts` | V2 | `test:graph` → Tests (graph) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/graph-integration.test.ts` | non | `test:graph` → Tests (graph) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer ; sous-processus | inclus V4 suspendu |
| `tests/graph-local-state.test.ts` | V2 | `test:graph` → Tests (graph) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/graph-perf.test.ts` | V3 | `test:graph` → Tests (graph) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer ; charge synthétique | aucun |
| `tests/graph-security.test.ts` | V3 | `test:graph` → Tests (graph) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/integration-pipeline.test.ts` | V3 | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/konstruktor-apply-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires; modèle simulé | exclu V4 : build Next / navigateur |
| `tests/konstruktor-apply.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/konstruktor-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires; modèle simulé | exclu V4 : build Next / navigateur |
| `tests/konstruktor-suggestions-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires; modèle simulé | exclu V4 : build Next / navigateur |
| `tests/konstruktor-suggestions.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/konstruktor.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/llm-config.test.ts` | non | `test:llm` → Tests (core) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas ; serveur HTTP loopback simulé | inclus V4 suspendu |
| `tests/llm-integration.test.ts` | non | `test:llm` → Tests (core) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas ; serveur HTTP loopback simulé | inclus V4 suspendu |
| `tests/llm-ollama.test.ts` | non | `test:llm` → Tests (core) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas ; serveur HTTP loopback simulé | inclus V4 suspendu |
| `tests/llm-ui.test.tsx` | V2 | `test:llm` → Tests (core) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/markdown-view.test.tsx` | V1 | `test:publications` → Tests (core) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/migration-copy.test.ts` | non | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas ; sous-processus npx hors ligne à isoler | inclus V4 suspendu |
| `tests/personal-topics.test.ts` | V3 | `test:topics` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/publication-design-browser.test.ts` | non | `test:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/publication-panel.test.tsx` | V2 | `test:publications` → Tests (core) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/publication-sources.test.ts` | V2 | `test:publications` → Tests (core) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/publication-store-cache.test.ts` | V3 | `test:xiagents` → Tests (agents) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer ; watcher, état global et HMR simulé | aucun |
| `tests/publications.test.ts` | V2 | `test:publications` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/realtime-events.test.ts` | V3 | `test:publications` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/search-browser.test.ts` | non | `test:topics:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/search-publications.test.ts` | V2 | `test:topics` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/search.test.ts` | V2 | `test:topics` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/server-shutdown.test.ts` | non | `test:auth` → Build and server tests | S | build et serveur Next, SQLite/vault temporaires, loopback | exclu V4 : build Next / navigateur |
| `tests/sources-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/supervision-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/supervision.test.ts` | V3 | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/system-agent-tasks.test.ts` | V3 | `test:xiagents` → Tests (agents) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/system-agents-http.test.ts` | non | `test:xiagents:pages` → Build and server tests | S | build et serveur Next, SQLite/vault temporaires, loopback | exclu V4 : build Next / navigateur |
| `tests/system-agents.test.ts` | V2 | `test:xiagents` → Tests (agents) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/topic-discovery.test.ts` | V3 | `test:topics` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/topic-network-browser.test.ts` | non | `test:topics:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/topic-network.test.ts` | V2 | `test:topics` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/topic-privacy.test.ts` | V2 | `test:topics` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/topic-relations.test.ts` | V2 | `test:topics` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/topics-browser.test.ts` | non | `test:topics:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/topics.test.ts` | V3 | `test:topics` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer ; sous-processus | aucun |
| `tests/watch-collect.test.ts` | non | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas ; serveur HTTP loopback simulé | inclus V4 suspendu |
| `tests/watch-draft.test.ts` | V3 | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/watch-evaluate.test.ts` | non | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas ; serveur HTTP loopback simulé | inclus V4 suspendu |
| `tests/watch-events.test.ts` | non | `test:watch` → Tests (agents) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer ; sous-processus ; évènements / horloge simulés | inclus V4 suspendu |
| `tests/watch-format.test.ts` | V1 | `test:watch` → Tests (agents) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/watch-publish.test.ts` | V3 | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/watch-source-admin.test.ts` | V3 | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/watch-trust.test.ts` | V3 | `test:watch` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/watch.test.ts` | non | `test:watch` → Tests (agents) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer ; sous-processus | inclus V4 suspendu |
| `tests/xi-conversation-store.test.ts` | V2 | `test:publications` → Tests (core) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/xi-live-browser.test.ts` | non | `test:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/xiagents-attention.test.ts` | V2 | `test:xiagents` → Tests (agents) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/xiagents-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/xiagents-calendar.test.ts` | V2 | `test:xiagents` → Tests (agents) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/xiagents-create-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/xiagents-creation.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/xiagents-deploy-resume.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/xiagents-deploy.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/xiagents-exclusions.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/xiagents-generation.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/xiagents-handles.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/xiagents-import-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/xiagents-orchestrator.test.ts` | V3 | `test:xiagents` → Tests (agents) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/xiagents-page.test.ts` | non | `test:xiagents:pages` → Build and server tests | S | build et serveur Next, SQLite/vault temporaires, loopback | exclu V4 : build Next / navigateur |
| `tests/xiagents-schedule-ui.test.tsx` | V2 | `test:xiagents` → Tests (agents) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/xiagents-suggest.test.ts` | V1 | `test:xiagents` → Tests (agents) | U | Node/tsx, calcul ou rendu | aucun |
| `tests/xiagents-topic-refs.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/xiagents-widget-browser.test.ts` | non | `test:xiagents:e2e` → Browser E2E | N | Chrome, Playwright, build/serveur Next, SQLite/vault temporaires | exclu V4 : build Next / navigateur |
| `tests/xiagents-widget.test.tsx` | V3 | `test:xiagents` → Tests (agents) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |
| `tests/xiagents-yaml.test.ts` | V3 | `test:xiagents` → Tests (agents) | IS | doubles modèle ou fetch ; fixtures temporaires selon cas | aucun |
| `tests/xiagents.test.ts` | V3 | `test:xiagents` → Tests (agents) | I | Node/tsx, fixtures locales ; dépendances précises à confirmer | aucun |

Total : 88 fichiers ; 57 sélectionnés en V1–V3, 31 reportés ; 88 sélectionnés en CI. Les neuf prévus pour V4 ne sont pas exécutés. Cette matrice n’établit pas une couverture de lignes ou de fonctionnalités.

Sources de qualification : `phase-4-V2-test-matrix.md`, `phase-4-V3-test-matrix.md`, `phase-4-V4-test-matrix.md` et fichier lui-même ; les sous-processus, fixtures et objets de test peuvent se recouper avec d’autres types.
