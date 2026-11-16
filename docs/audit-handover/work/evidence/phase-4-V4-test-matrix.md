# V4 — classement des 31 fichiers restants

Référence 4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2 ; analyse statique, aucun test exécuté. Les catégories se croisent : tous peuvent utiliser SQLite/vault temporaires.

## 5 retenus : réseau simulé / serveurs locaux

- `tests/llm-config.test.ts` : serveur HTTP factice sur port éphémère ; test de refus sur 127.0.0.1:9 (`:278–280`), d'où nécessité d'un réseau propre.
- `tests/llm-integration.test.ts` : SQLite/vault temporaires, serveur modèle factice loopback, appels applicatifs ; aucun Ollama réel démontré.
- `tests/llm-ollama.test.ts` : faux serveur loopback, politiques d'URL, erreurs et résolution ; réseau propre nécessaire si protection testée échoue.
- `tests/watch-collect.test.ts` : serveur HTTP simulé, DNS/fetch de test et refus SSRF ; une sortie réelle serait dangereuse en cas de défaut, donc namespace réseau obligatoire.
- `tests/watch-evaluate.test.ts` : serveurs inférence fictifs, résolveurs et fixtures temporaires ; pas de validation d'un LLM réel.

## 4 retenus : sous-processus

- `tests/graph-integration.test.ts` : SQLite/vault temporaires ; enfants `graph-seed-demo.ts` et `graph-reindex.ts` (`:553–565`), opérations réelles sur fixtures uniquement.
- `tests/migration-copy.test.ts` : crée une ancienne instance fictive, puis migre une copie ; lance `npx tsx` (`:64–65`). Installation locale préalable, npm configuré hors ligne et réseau isolé ; aucun contournement si npx échoue. Migrations uniquement sur fixtures dans TMPDIR.
- `tests/watch-events.test.ts` : enfant `tests/helpers/watch-logs.ts` (`:110`), collecte stdout/stderr.
- `tests/watch.test.ts` : enfants `tests/helpers/watch-child.ts`, SQLite/vault temporaires, concurrence et publication sur fixtures.

## 22 exclus : serveur Next et navigateur

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

Les tests Next nécessitent un build de production et `tests/helpers/next-server.ts:26–42,66–72` démarre le serveur sur un port loopback choisi puis relâché, avec migrations sur base temporaire. Il existe donc une petite course d'attribution du port. Les 18 tests navigateur utilisent Playwright et Chrome ; `/usr/bin/google-chrome-stable` est présent, mais son fonctionnement et sa sandbox ne sont pas vérifiés. Les tests ouvrent un serveur et peuvent écrire dans leurs fixtures ; certains enregistrent diagnostics sous TMPDIR. On ne désactive pas la sandbox Chrome. Le build est exclu : `src/app/layout.tsx:2` utilise `next/font/google` ; Next peut joindre Google pour CSS et polices. Son mécanisme interne `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` est une piste non essayée, qui substituerait les ressources ; il ne prouve pas un build réel hors ligne. Aucun autre accès réseau du build n'a été exclu. Voir `06-VALIDATION-EVIDENCE.md`.

Total : 9 fichiers proposés, 22 exclus. Les inclusions restent conditionnées à la disponibilité réelle de bubblewrap et du namespace réseau ; aucun repli non confiné n'est prévu. La présence des binaires n'établit pas que les namespaces sont autorisés.
