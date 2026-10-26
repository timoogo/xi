# Brief v0 — challenger l’UX de Ξ

## Contexte produit

Ξ est un espace privé de veille et de publication en français. Un ΞAgent est une identité éditoriale qui collecte des sources, analyse des actualités avec un modèle local, propose des brouillons et ne publie qu’après validation humaine (sauf mécanisme autonome explicitement configuré). Le feed principal ressemble à un réseau social textuel, tandis que les pages de gestion exposent beaucoup de diagnostics et de contrôles.

Le challenge demandé porte principalement sur la simplification UX de la page agent `/dashboard/xiagents/[id]` et de la page détail source réelle `/dashboard/sources/[sourceId]`. Le chemin `/dashboard/xiagents/sources/[id]` n’existe pas dans le code actuel.

## Objectif du challenge

Proposer une hiérarchie plus lisible, une divulgation progressive et des regroupements plus compréhensibles sans perdre la densité opérationnelle. Le résultat doit aider un propriétaire à répondre rapidement à :

- Que fait cet agent maintenant ?
- Que dois-je valider ou corriger ?
- Quelle source ou quel modèle explique le résultat ?
- Quelle action est sûre et réversible, et laquelle demande une confirmation ?

## Identité visuelle à reproduire fidèlement

- Colonne centrale étroite, centrée dans un shell à trois colonnes; rail gauche et panneau de découverte à droite sur grand écran.
- Header sticky d’environ 53px, fond translucide avec flou, bordure basse, titres Geist gras.
- Interface majoritairement monochrome, basée sur les tokens CSS `background`, `foreground`, `muted`, `border`, `accent`, `destructive`, avec un lien/CTA bleu-vert `chart-2`.
- Sections séparées par des lignes horizontales et padding `p-4`; densité régulière `gap-2/3/4`, peu d’ombres.
- Contrôles arrondis modérément (`rounded-md`), navigation/avatars/CTA sociaux en pill (`rounded-full`).
- Avatar Bloub comme marque distinctive : SVG coloré sur fond gris clair, yeux blancs, état neutre pour l’identité; aperçu animé uniquement lorsqu’il s’agit d’un état réel ou d’un studio.
- Feed publication localement sombre (`#000`, `#e7e9ea`, bordure `#2f3336`, liens `#58b6f5`) même si le dashboard est clair/sombre selon le thème.
- Icônes Lucide, taille habituelle 18–26px; états de confiance avec Check vert, CircleDashed gris, X rouge.
- Texte et labels en français; conserver les termes produit « ΞAgent », « Bloub », « veille », « brouillon », « confiance », « topics ».

## Contraintes fonctionnelles non négociables

- Ne pas inventer une nouvelle marque, palette, typographie ou navigation.
- Ne pas supprimer les distinctions : identité/avatar vs activité, veille vs publication, brouillon privé vs publication confirmée, confiance globale vs agent/topic.
- Ne pas masquer les états d’erreur, les conflits de révision, les actions en cours, les confirmations destructives ou les limites de configuration IA.
- Conserver l’accessibilité observée : titres de sections, labels explicites, `role=status`/`role=alert`, focus visible, skip link, navigation clavier, respect de `prefers-reduced-motion`.
- Les actions async affichent leur état et désactivent le contrôle; les données inconnues restent « inconnues »/« non renseignées », jamais estimées visuellement.
- Les blocs diagnostics et développement peuvent être déplacés ou regroupés derrière une disclosure, mais ils doivent rester accessibles.

## Priorités UX à explorer

1. Donner un résumé d’état/action en tête de la page agent, puis regrouper Avatar, Publication, Pilotage, IA, Veille, Historique et Feed.
2. Réduire la sensation de longue page en utilisant des sections repliables ou une navigation locale, sans transformer les opérations critiques en modales opaques.
3. Transformer la page source en une lecture progressive : identité/état de collecte, confiance, métadonnées, actualités, historique, suppression.
4. Rendre visibles les décisions qui demandent une intervention humaine (source en attente, brouillon à relire, modèle indisponible, collecte en erreur).
5. Préserver le feed social et ses affordances : avatar, date, message, sources, branches, réponse/partage, bouton de nouvelles publications.

## Livrable attendu de v0

Créer une proposition d’écran responsive (mobile, tablette, desktop) et annoter les choix qui changent la hiérarchie. Les écrans doivent être crédibles avec des données réalistes en français, y compris états vides, chargement, erreur, pause, source refusée et confirmation de suppression. Montrer au moins un cas clair de page agent active avec un brouillon à relire et un cas de source en attente de confiance.

Ne pas remplacer la densité métier par des statistiques décoratives, des graphiques inventés ou des cartes génériques. L’objectif est un challenge UX ancré dans les composants et comportements existants du dépôt.

