#!/usr/bin/env bash
# L'installation télécharge éventuellement des paquets ; aucune vérification n'utilise de service externe intentionnellement.
set -u -o pipefail
umask 077
reference=4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2
root=$(git rev-parse --show-toplevel) || { printf 'Dépôt Git introuvable.\n' >&2; exit 2; }
cd "$root" || exit 2
head_commit=$(git rev-parse HEAD) || exit 2
if [[ "$head_commit" != "$reference" ]]; then
  printf 'HEAD différent de la référence : %s\nArrêt : demander une décision avant de continuer.\n' "$head_commit" >&2
  exit 2
fi
for cmd in git tar node pnpm mktemp tee; do
  command -v "$cmd" >/dev/null 2>&1 || { printf 'Prérequis absent : %s\n' "$cmd" >&2; exit 2; }
done
run_dir=$(mktemp -d "$root/docs/audit-handover/work/logs/v1-$(date +%Y%m%d-%H%M%S)-XXXXXX") || exit 2
scratch=$(mktemp -d "/tmp/xi-audit-v1-XXXXXXXX") || exit 2
mkdir -p "$scratch/project" "$scratch/home" "$scratch/tmp" "$scratch/store" "$scratch/cache" || exit 2
printf 'Commit : %s\nLogs : %s\nCopie temporaire : %s\n' "$reference" "$run_dir" "$scratch" | tee "$run_dir/context.txt"
printf 'La copie temporaire reste disponible pour inspection après la fin.\n' | tee -a "$run_dir/context.txt"
git status --short --branch > "$run_dir/git-status-before.txt" || exit 2
# archive contient exclusivement les fichiers suivis de ce commit, sans .env.local ni données ignorées.
if ! git archive "$reference" | tar -x -C "$scratch/project"; then
  printf 'Échec de création de la copie isolée.\n' >&2
  exit 2
fi
cd "$scratch/project" || exit 2
# Aucun héritage de variables applicatives ou de proxy. PATH est conservé pour node/pnpm/outils système.
clean_env=(env -i "PATH=$PATH" "HOME=$scratch/home" "TMPDIR=$scratch/tmp" \
  "CI=1" "NEXT_TELEMETRY_DISABLED=1" "COREPACK_ENABLE_NETWORK=0" "XDG_CACHE_HOME=$scratch/cache" \
  "AUTH_DATABASE_PATH=$scratch/tmp/isolated.sqlite" "XI_VAULT_PATH=$scratch/tmp/vault" \
  "BETTER_AUTH_URL=http://127.0.0.1:3000" \
  "BETTER_AUTH_SECRET=xi-audit-temporary-secret-not-for-use-00000000" \
  "XI_WATCH_DISABLED=true" "XI_WATCH_AUTOPUBLISH=false" "XI_WATCH_AUTOPUBLISH_PUBLIC=false")
mkdir -p "$scratch/tmp/vault" || exit 2
printf 'nom\tcode\tdurée_secondes\tcommande\n' > "$run_dir/results.tsv"
failed=0
last_rc=0
last_log_rc=0
run_check() {
  local name=$1; shift
  local start end rc log_rc
  start=$(date +%s)
  printf '\n>>> %s\n' "$name"
  printf '%q ' "$@" > "$run_dir/$name.command.txt"
  printf '\n' >> "$run_dir/$name.command.txt"
  "${clean_env[@]}" "$@" 2>&1 | tee "$run_dir/$name.log"
  rc=${PIPESTATUS[0]} log_rc=${PIPESTATUS[1]}
  end=$(date +%s)
  printf '%s\t%s\t%s\t' "$name" "$rc" "$((end-start))" >> "$run_dir/results.tsv"
  printf '%q ' "$@" >> "$run_dir/results.tsv"
  printf '\n' >> "$run_dir/results.tsv"
  if (( rc != 0 || log_rc != 0 )); then failed=1; fi
  last_rc=$rc
  last_log_rc=$log_rc
  printf '<<< %s : code=%s, log=%s, durée=%ss\n' "$name" "$rc" "$log_rc" "$((end-start))"
}
printf 'Installation isolée : scripts de cycle de vie désactivés ; un accès au registre peut être nécessaire.\n'
printf 'esbuild, sharp et unrs-resolver déclarent des scripts ; leur fonctionnement sans scripts reste à vérifier.\n'
run_check install pnpm install --frozen-lockfile --ignore-scripts --store-dir "$scratch/store"
if (( last_rc != 0 || last_log_rc != 0 )); then
  printf 'Installation échouée : lint, typecheck et tests non exécutés. Voir %s/install.log\n' "$run_dir" >&2
  printf 'lint\tNON_EXÉCUTÉ\t0\tinstallation échouée\ntypecheck\tNON_EXÉCUTÉ\t0\tinstallation échouée\ntests-cibles\tNON_EXÉCUTÉ\t0\tinstallation échouée\n' >> "$run_dir/results.tsv"
  cd "$root" || exit 2
  git status --short --branch > "$run_dir/git-status-after.txt" || true
  exit 1
fi
# Appels directs des binaires de la copie : aucune réinstallation implicite par pnpm run/exec.
run_check lint ./node_modules/.bin/eslint .
# incremental=false empêche les caches TypeScript ; la copie ne contient pas les types générés Next.
run_check typecheck ./node_modules/.bin/tsc --noEmit --incremental false
# Sélection manuelle de tests sans serveur ni service externe ; watch-format utilise SQLite :memory:.
run_check tests-cibles ./node_modules/.bin/tsx --tsconfig tests/tsconfig.json --test \
  tests/conversation.test.ts tests/markdown-view.test.tsx tests/xiagents-suggest.test.ts \
  tests/watch-format.test.ts tests/bloub-avatar.test.tsx
cd "$root" || exit 2
git status --short --branch > "$run_dir/git-status-after.txt" || failed=1
printf '\nRésultats : %s\n' "$run_dir/results.tsv"
printf 'Code global : %s\n' "$failed"
exit "$failed"
