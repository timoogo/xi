# Inventaire UX des pages XiAgents et sources

## Périmètre réel

- Page agent : `/dashboard/xiagents/[id]` (`src/app/dashboard/xiagents/[id]/page.tsx`).
- La route demandée `/dashboard/xiagents/sources/[id]` n’existe pas dans le dépôt. La page source réelle est `/dashboard/sources/[sourceId]` (`src/app/dashboard/sources/[sourceId]/page.tsx`), atteinte depuis `/dashboard/sources` et depuis les listes de veille.

## `/dashboard/xiagents/[id]`

La page est une longue colonne unique, chaque bloc étant une section séparée par `border-b` et `p-4`, avec `PageHeader` sticky et retour vers `/dashboard/xiagents`.

### Identité et navigation

- Nom, handle `@…`, avatar Bloub de 64px et description.
- Topics associés, affichés en texte séparé par `·`; fallback « Aucun topic associé ».
- Actions : voir le profil, exporter la configuration YAML, dupliquer sans historique.
- États à prévoir : compte introuvable (404), description/topics absents, avatar courant indisponible.

### Avatar

- `AvatarPanel` affiche l’état réel, ouvre l’éditeur Bloub et permet d’enregistrer ou annuler une configuration modifiée.
- États/feedback : configuration inchangée (boutons désactivés), enregistrement, succès, erreur de concurrence ou réseau.
- L’aperçu peut être animé, mais l’activité réelle ne doit pas être confondue avec l’identité visuelle.

### Générer une publication

- `PublicationGenerator` explique la chaîne veille vérifiée → modèle → contrôles → brouillon privé.
- Affiche le modèle résolu, son état de configuration et les candidats éditoriaux disponibles.
- Contrôles : format `Post simple`/`Thread`, choix de l’information vérifiée, bouton de génération.
- États : aucune information candidate, modèle indisponible, rédaction en cours (potentiellement plusieurs minutes), erreur, notice de succès, aperçu du brouillon.
- Le brouillon est ensuite relu, confirmé ou rejeté via `WatchDrafts`.

### Pilotage

- `AgentControl` expose le mode : désactivé, veille désactivée, automatique, en pause indéfinie ou jusqu’à une date.
- Affiche les fenêtres de veille/publication et les prochaines ouvertures.
- Actions : reprendre maintenant, reprendre avec rattrapage, mettre en pause avec date et stratégie de reprise, exécuter une veille maintenant, analyser une actualité, rédiger un candidat.
- Réglages imbriqués : calendrier (`ScheduleForm`/`CalendarEditor`) et profil éditorial (périmètre, charte).
- États : action en cours, succès, erreur, formulaire sale/non enregistrable, absence de candidats.

### Intelligence artificielle

- `AgentLLMPanel` résume l’instance, le modèle, la source de configuration et le mode (hérité, autre modèle, autre instance).
- Actions : tester le modèle, modifier, ouvrir la configuration globale.
- Le test affiche réussite, instance/modèle, latence et extrait de réponse; l’échec expose code et message sans bascule automatique.
- Le formulaire permet de choisir le mode, l’instance, le modèle et les options d’inférence héritées.

### Veille autonome

- `WatchPanel` regroupe état de veille, publication automatique, prochaine fenêtre, état du modèle et diagnostics.
- Sous-sections : sources (en attente/actives/refusées/désactivées), dernières collectes, actualités détectées, candidats éditoriaux, tâches/jobs, paramètres de veille, proposition d’une source.
- Actions source : approuver, refuser, désactiver/réactiver, modifier, supprimer; détails de collecte et historique via `details`.
- Les états métier visibles sont nombreux : proposée, approuvée, refusée, désactivée, supprimée; collecte réussie/inchangée/erreur/robots; candidat en évaluation, retenu, en attente, rejeté, fusionné, brouillon rédigé.

### Historique et outils

- `RunHistory` affiche les exécutions réelles dans un tableau : début, type, déclencheur, statut, durée, lien détail; pagination à 30 lignes.
- `ManualGenerator` est caché dans `details` « Outils de test et de développement » : fixtures post/thread, visibilité privée/publique, prévisualisation Markdown, édition, confirmation explicite, publication de test.
- La page termine par « Historique des publications » et un `PublicationFeed` filtré sur l’auteur de l’agent, avec liens d’ouverture et pagination.

### Simplification UX à challenger

La simplification peut surtout agir sur la hiérarchie, les regroupements et la divulgation progressive. Elle doit conserver : validation humaine avant publication, distinction veille/publication, états de confiance, statut réel du modèle, feedback d’action, sécurité des suppressions et accès à l’historique.

## Page source réelle : `/dashboard/sources/[sourceId]`

`PageHeader` affiche l’éditeur/publicateur et le domaine, avec retour à `/dashboard/sources`; `SourceDetailView` est une longue page éditable.

1. **Source** : nom, domaine, URL du flux, site, type RSS/Atom ou API JSON, provenance, date, fiabilité, topics.
2. **Collecte** : active/arrêtée/désactivée, fréquence, dernière et prochaine collecte, erreurs; actions désactiver/réactiver; dernières collectes dépliables.
3. **Confiance** : décision globale, matrice effective par ΞAgent/topic, décisions par topic, révocation; la règle affichée est « un refus l’emporte » et l’absence de décision reste en attente.
4. **Métadonnées** : nom, groupe propriétaire, orientation, fiabilité, fréquence, topics; formulaire enregistrable sauf source refusée.
5. **Dernières actualités collectées** : titres, liens externes, dates de publication/collecte.
6. **Historique des décisions** : événements inversés du plus récent au plus ancien, décisions spécifiques en vigueur.
7. **Supprimer la source** : explication de la portée, bouton destructif et `Dialog` avec confirmation explicite.

États à transmettre : source 404, collecte jamais exécutée, erreurs consécutives, source refusée/désactivée, conflits de révision (rechargement), notice de succès, erreur d’action, liste vide, suppression confirmée ou annulée.

