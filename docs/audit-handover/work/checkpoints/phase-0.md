# Checkpoint phase 0 — 2026-11-06

Référence : `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`, `main`. Achevé : état Git initial, dimensionnement, domaines candidats, commandes déclarées et plan. Résultats et limites : `../../00-REPOSITORY-MAP.md`. Aucune analyse fonctionnelle détaillée ni exécution de tests.

Reproduction du comptage des lignes depuis la racine, lecture uniquement des fichiers suivis présents :

```sh
git ls-files | wc -l
git log --all --format='%H' | wc -l
git branch --list
git branch -r --list
git tag -l
python3 -c 'import subprocess,pathlib,collections; paths=subprocess.check_output(["git","ls-files","-z"]).decode().split("\0"); groups=collections.defaultdict(lambda:[0,0]);
for s in paths:
 p=pathlib.Path(s)
 if s and p.suffix in (".ts",".tsx",".js",".jsx",".mjs",".css") and s.startswith(("src/","scripts/","tests/","prototypes/")) and not s.endswith(".d.ts"):
  try: n=len(p.read_bytes().splitlines())
  except OSError: continue
  k=s.split("/")[0]; groups[k][0]+=1; groups[k][1]+=n
for k,v in sorted(groups.items()): print(k,*v)
print("TOTAL",sum(v[0] for v in groups.values()),sum(v[1] for v in groups.values()))
print("TEST_FILES",sum(1 for s in paths if s.startswith("tests/") and (s.endswith(".test.ts") or s.endswith(".test.tsx"))))'
```

Résultat : `src 351 30804`, `scripts 8 477`, `tests 96 17059`, `prototypes 12 487`, total `467 48827`, fichiers de tests `88`. L'outil compte les lignes physiques, pas le code logique ; l'exclusion des fichiers générés suivis n'est pas garantie.

État initial de `git status --porcelain=v1 --untracked-files=all` : vide. `git rev-parse --is-shallow-repository` : `false`. `gh pr list --repo timoogo/xi --state all --limit 100 --json number,state,title` n'a pas répondu après environ 15 secondes et a été interrompue (130) : aucune conclusion sur les PR distantes. HEAD mentionne une PR #1 ; consulter les métadonnées lors de H2 si accessibles. Aucune donnée locale sensible copiée dans l'audit.

Reprise : lire `../../00-AUDIT-STATE.md`, vérifier HEAD et statut Git ; demander une décision si HEAD a changé. Attendre l'autorisation pour H1.
