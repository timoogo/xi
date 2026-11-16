# H2 — Preuves Git locales

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`, relevé 2026-11-06. Aucun changement de branche ni test.

## Branches de réinitialisation

`git rev-parse clean/password-reset feat/password-reset` : même SHA `f971712f2fe783d309b9e13bfa4810207a9e4b5c`. `git log --reverse --format='%h %aI %cI %s' 8763c6a..f971712` :

- `f1e1825` 2026-11-05 20:10:48 +01:00 : ajout CLI `scripts/reset-password.ts` et service `src/lib/password-reset.ts`, scripts et lockfile.
- `155e8c7` même horodatage : `tests/password-reset.test.ts` et script de test ; sept cas déclarés, non exécutés ici.
- `c6e5ece` même horodatage : documentation README.
- `f971712` 20:19:30 +01:00 : `src/components/password-recovery-dialog.tsx`, lien du formulaire `src/lib/forms/login.tsx`, instructions README, test navigateur et script.

`git show clean/password-reset:src/lib/password-reset.ts` : recherche par email, contrôle de compte credential et longueur, hachage Better Auth, transaction qui appelle `deleteUserSessions` et `updatePassword` ; mode interactif avec confirmation explicite. `git show clean/password-reset:scripts/reset-password.ts` : terminal interactif requis, saisie secrète, fermeture de base. Ce sont des mécanismes écrits, pas des garanties vérifiées. Le dialogue ne lance pas de reset : il fournit la commande locale.

`git diff --name-status main...clean/password-reset` : neuf fichiers : README, package.json, pnpm-lock.yaml, script reset, dialogue, formulaire login, service password-reset et deux tests. `git grep -n -i -E 'reset.?password|forgot.?password|password.?recovery|mot de passe oubli|changepassword|requestpasswordreset' HEAD -- src scripts tests README.md package.json docs` : aucun résultat dans les fichiers suivis à HEAD. `src/lib/forms/login.tsx` ne présente pas le dialogue ; `src/lib/auth.ts` configure Better Auth email/mot de passe mais ne définit pas de callback de récupération dans la configuration visible. Ceci justifie l'absence d'équivalent Xi explicite trouvé, sans prouver l'absence de capacités natives, de mécanismes indirects ou de récupération externe. Les fichiers de branche existent et sont potentiellement réutilisables ; adaptation et conformité, compatibilité avec l'état actuel et résultats des tests restent à évaluer ; ne pas recommander de merge en H2.

## Branche CI avant réécriture

`git diff --name-status 8763c6a ce6b899` et `git diff --name-status c2cfea7 cb3e8d4` sont vides : arbres de produits identiques à ces deux paires de jalons, malgré SHAs distincts. `git diff --name-status main backup/ci-before-rewrite` montre 13 fichiers, tous en statut M ou D en direction de backup, aucun fichier ajouté dans backup. Diff ciblé CI, `package.json`, route d'événements et scripts : différences attribuables aux corrections et diagnostics ultérieurs de main ; l'égalité des arbres entre `c2cfea7` et `cb3e8d4` prouve que backup ne contient pas de contenu supplémentaire par rapport à la version CI correspondante déjà ancêtre de main. Une fonctionnalité introduite puis supprimée après ce point est en principe possible ; aucune identifiée par cette comparaison. Pas de conclusion fonctionnelle de runtime.

## Documentation de jalons

`git show eeaa686:README.md` : en-tête explicite « MVP actuel » ; `git show 8763c6a:README.md` conserve cet en-tête malgré des ajouts ultérieurs. `docs/watch.md` nomme des phases 3, 4, 5 dans des descriptions de tests ; leur statut historique, leur périmètre officiel et leur éventuelle clôture ne sont pas démontrés. Aucune de ces mentions ne prouve une milestone achevée. Les affirmations datées du README sur les capacités doivent être croisées avec le code actuel lors de l'inventaire.
