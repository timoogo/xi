# Checkpoint V1 — 2026-11-06

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2` confirmée ; seul `docs/audit-handover/` non suivi. Inventaire des commandes, effets, dépendances, environnement et limites dans `../../06-VALIDATION-EVIDENCE.md`. Script utilisateur `../../run-safe-checks.sh` : copie `git archive`, installation isolée une seule fois, magasin temporaire, `--frozen-lockfile --ignore-scripts`, environnement nettoyé, lint/typecheck et cinq fichiers de tests ciblés ; logs et codes. Aucun test, build, lint, typecheck, worker ou migration exécuté par l'auditeur ; seule la syntaxe Bash a été contrôlée (`bash -n`, code 0). Les suites complètes et build sont exclus faute de preuve d'isolation complète et à cause d'effets réseau/processus possibles ; aucune garantie d'isolation réseau système.

Incident utilisateur `work/logs/v1-20261106-200552-W7BNUD/` : les trois commandes ont échoué avant vérification avec `ERR_PNPM_UNSAFE_MODULES_DIR`, échec d’environnement, pas des tests. Le lien symbolique a été retiré. Scripts d’installation de esbuild, sharp et unrs-resolver désactivés ; compatibilité à confirmer ; better-sqlite3 natif. Aucune installation lancée par l’auditeur ; `bash -n` seulement. Si installation échoue, validations non exécutées. Anciennes copies conservées.

Attente : l'utilisateur exécute `bash docs/audit-handover/run-safe-checks.sh` depuis la racine et fournit le chemin des logs/résultats. Après réception, vérifier HEAD, lire `results.tsv` et chaque log, nombre de tests/échecs/skips et versions, distinguer l'environnement, puis consigner les preuves sans qualifier automatiquement les fonctionnalités. Ne pas lancer les commandes soi-même. V2 est en attente des résultats utilisateur.

## Résultats utilisateur reçus

Lancement `work/logs/v1-20261106-201141-8wHwyT/` au commit de référence : installation code 0 (7 s), lint code 0 (7 s ; trois avertissements prototype), typecheck code 0 (9 s), tests code 0 (4 s ; 25 réussis, 0 échec/ignoré/annulé). Statuts Git avant/après : seul dossier d'audit non suivi. Résultats et limites dans `../../06-VALIDATION-EVIDENCE.md`. Aucune exécution par l'auditeur ; aucun statut fonctionnel modifié.
