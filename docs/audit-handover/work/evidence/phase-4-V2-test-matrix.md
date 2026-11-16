# Classification V2 des 83 fichiers non exécutés en V1

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Classification statique ciblée, sans exécution ; les indices tirés du texte des fichiers sont des besoins possibles, et les dépendances transitives restent à vérifier. Les tests retenus ont été examinés plus précisément : les 9 premiers n’ouvrent pas de serveur dans leur code ; les 11 suivants utilisent `mkdtemp` et SQLite en mémoire ou fichier temporaire. La copie Git et TMPDIR isolent les données connues ; aucune sandbox réseau ou filesystem système n’est fournie.

Légende : `local` = calcul/rendu ou fixtures ; `stockage` = SQLite ou fichiers temporaires explicitement identifiés ; `serveur` = Next et/ou Chrome ; `réseau` = serveur local, fetch ou comportement réseau à approfondir ; `sous-processus` = spawn/exec identifié ; `LLM simulé` = indication d’un double dans le code/helper, pas preuve exhaustive ; `à approfondir` = dépendances des helpers ou effets non certifiés. Les catégories se recouvrent. Les 63 fichiers différés ne sont pas automatiquement dangereux et ne sont pas inclus dans le script.

- `tests/account-store-cache.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/accounts-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, réseau réel ou simulé.
- `tests/accounts.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/arbiter-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, SQLite/vault temporaire probable.
- `tests/arbiter.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/auth.test.ts` — **différé** ; à approfondir, serveur/navigateur, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/avatars-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, SQLite/vault temporaire probable.
- `tests/avatars.test.ts` — **V2 calcul/rendu** ; local.
- `tests/bloub.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/e2e.test.ts` — **différé** ; à approfondir, serveur/navigateur.
- `tests/editorial-queue.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/feed.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/graph-engine.test.ts` — **V2 calcul/rendu** ; local.
- `tests/graph-index.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/graph-integration.test.ts` — **différé** ; à approfondir, sous-processus, SQLite/vault temporaire probable.
- `tests/graph-local-state.test.ts` — **V2 calcul/rendu** ; local.
- `tests/graph-perf.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/graph-security.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/integration-pipeline.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable, LLM double probable.
- `tests/konstruktor-apply-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, réseau réel ou simulé, LLM double probable.
- `tests/konstruktor-apply.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/konstruktor-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, réseau réel ou simulé, LLM double probable.
- `tests/konstruktor-suggestions-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, réseau réel ou simulé, LLM double probable.
- `tests/konstruktor-suggestions.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/konstruktor.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/llm-config.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/llm-integration.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/llm-ollama.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, LLM double probable.
- `tests/llm-ui.test.tsx` — **V2 calcul/rendu** ; local.
- `tests/migration-copy.test.ts` — **différé** ; à approfondir, sous-processus, SQLite/vault temporaire probable, LLM double probable.
- `tests/personal-topics.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/publication-design-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, SQLite/vault temporaire probable.
- `tests/publication-panel.test.tsx` — **V2 calcul/rendu** ; local.
- `tests/publication-sources.test.ts` — **V2 calcul/rendu** ; local.
- `tests/publication-store-cache.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/publications.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/realtime-events.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/search-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, SQLite/vault temporaire probable.
- `tests/search-publications.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/search.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/server-shutdown.test.ts` — **différé** ; à approfondir, serveur/navigateur, réseau réel ou simulé.
- `tests/sources-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, SQLite/vault temporaire probable.
- `tests/supervision-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, SQLite/vault temporaire probable.
- `tests/supervision.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/system-agent-tasks.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/system-agents-http.test.ts` — **différé** ; à approfondir, serveur/navigateur, réseau réel ou simulé.
- `tests/system-agents.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/topic-discovery.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/topic-network-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur.
- `tests/topic-network.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/topic-privacy.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/topic-relations.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/topics-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, réseau réel ou simulé.
- `tests/topics.test.ts` — **différé** ; à approfondir, sous-processus, SQLite/vault temporaire probable.
- `tests/watch-collect.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable, LLM double probable.
- `tests/watch-draft.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/watch-evaluate.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable, LLM double probable.
- `tests/watch-events.test.ts` — **différé** ; à approfondir, sous-processus, SQLite/vault temporaire probable.
- `tests/watch-publish.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/watch-source-admin.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/watch-trust.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable, LLM double probable.
- `tests/watch.test.ts` — **différé** ; à approfondir, sous-processus, SQLite/vault temporaire probable.
- `tests/xi-conversation-store.test.ts` — **V2 stockage temporaire** ; stockage.
- `tests/xi-live-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, SQLite/vault temporaire probable.
- `tests/xiagents-attention.test.ts` — **V2 calcul/rendu** ; local.
- `tests/xiagents-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, SQLite/vault temporaire probable.
- `tests/xiagents-calendar.test.ts` — **V2 calcul/rendu** ; local.
- `tests/xiagents-create-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur.
- `tests/xiagents-creation.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/xiagents-deploy-resume.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/xiagents-deploy.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/xiagents-exclusions.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/xiagents-generation.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable, LLM double probable.
- `tests/xiagents-handles.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/xiagents-import-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur.
- `tests/xiagents-orchestrator.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/xiagents-page.test.ts` — **différé** ; à approfondir, serveur/navigateur, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/xiagents-schedule-ui.test.tsx` — **V2 calcul/rendu** ; local.
- `tests/xiagents-topic-refs.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/xiagents-widget-browser.test.ts` — **différé** ; à approfondir, serveur/navigateur, SQLite/vault temporaire probable.
- `tests/xiagents-widget.test.tsx` — **différé** ; à approfondir, SQLite/vault temporaire probable.
- `tests/xiagents-yaml.test.ts` — **différé** ; à approfondir, réseau réel ou simulé, SQLite/vault temporaire probable.
- `tests/xiagents.test.ts` — **différé** ; à approfondir, SQLite/vault temporaire probable.

Total : 83 fichiers ; 9 calcul/rendu, 11 stockage temporaire, 63 différés. Les cinq fichiers V1 sont exclus de cette liste.

Le classement « probable » ne garantit pas qu’aucun helper ne contacte un service ; les 63 différés exigent un examen avant inclusion. Les suites navigateur/Next nécessitent un build distinct ; les suites de collecte ou LLM peuvent ouvrir des serveurs loopback, d’autres injectent des réponses simulées. Les scripts de migration, sous-processus et utilisation de `npx` demandent un examen particulier.
