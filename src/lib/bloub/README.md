# Bloub module

Generic avatar layer over [bloub-react](https://github.com/ShunquanWang/bloub-react)
(MIT, © 2026 Shunquan Wang), itself a React port of
[bloub](https://github.com/jeremy-prt/bloub) (MIT, © 2026 Jérémy Perret).
The library is used through its public API only (`BloubBot`, catalogs, cycle
helpers); no library file is copied or modified. Its licence ships with the
package in `node_modules/bloub-react/LICENSE.md`.

- `types.ts` — `BloubConfig` (versioned, serialisable) and the activity vocabulary.
- `config.ts` — strict validation against the library catalogs, defaults.
- `presets.ts` — deterministic appearance from a 128-bit seed.
- `state-mapping.ts` — activity → `BloubBot` props (closed eyes, busy eyes).
- `src/components/bloub/` — avatar, editor preview and studio-style editor.

Nothing here imports Ξ code: the host decides the activity and stores the
configuration. `bloub-react` is pinned to an exact version because the closed
eyes frame depends on the engine's blink schedule (checked by tests/bloub-avatar.test.tsx).
