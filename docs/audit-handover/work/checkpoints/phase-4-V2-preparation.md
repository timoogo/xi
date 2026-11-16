# Préparation V2 — 2026-11-06

Référence confirmée `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. L'utilisateur a exécuté V1 ; preuves dans `../../06-VALIDATION-EVIDENCE.md`. 83 fichiers non couverts listés individuellement dans `../evidence/phase-4-V2-test-matrix.md` : 9 calcul/rendu et 11 stockage temporaire sélectionnés, 63 différés ; étiquettes heuristiques et dépendances transitives non entièrement auditées. `../../run-v2-checks.sh` prépare une copie, installation gelée une fois sans scripts, exécute deux groupes séquentiels et journalise ; script non exécuté par l'auditeur, seule vérification `bash -n`. Build exclu : Next Fonts Google tente le réseau normalement ; variable de simulation interne examinée mais non testée. Tous tests navigateur/Next et autres fichiers différés exclus ; LLM réel et données réelles exclus. Aucun statut fonctionnel modifié.

Reprise : attendre l'exécution utilisateur et le répertoire de logs, vérifier HEAD et lire `results.tsv`, `install.log`, les deux logs de tests et statuts Git ; comptabiliser réussites/échecs/skips et analyser tout effet d'environnement. Ne pas lancer soi-même les tests sans instruction nouvelle. Aucun résultat de V2 encore disponible.

## Résultats reçus

L'utilisateur a exécuté le script : `work/logs/v2-20261106-202249-jSwYBH/`, même commit de référence. Installation 0 (34 s), calcul/rendu 0 (6 s ; 50 réussis), stockage temporaire 0 (11 s ; 72 réussis), aucun échec, annulation ou skip dans les deux journaux. Les statuts Git avant/après montrent uniquement le dossier d'audit non suivi ; données ignorées non couvertes. Résultats et limites intégrés dans `../../06-VALIDATION-EVIDENCE.md`. Les 63 fichiers différés, build, navigateur et LLM réel restent non exécutés par ces scripts. Aucun changement de statut fonctionnel.

## Suite V3

La mission utilisateur suivante confirme les résultats V2 déjà enregistrés : aucune duplication de résultats, aucune exécution supplémentaire. Les 63 fichiers restants ont été classés dans `../evidence/phase-4-V3-test-matrix.md` ; préparation de 32 fichiers pour V3, 31 différés. Voir checkpoint V3 ; V2 est réussi sur son périmètre, la validation globale reste incomplète.
