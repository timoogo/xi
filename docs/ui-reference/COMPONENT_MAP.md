# Carte des composants à réutiliser

Les chemins ci-dessous sont ceux du projet actuel. v0 doit les traiter comme des références de structure et de comportement, pas comme une invitation à recréer des primitives.

## Pages et shell

- `src/app/dashboard/layout.tsx` — composition trois colonnes, largeur centrale et responsive.
- `src/app/dashboard/_components/navigation.tsx` — rail desktop, barre mobile, thèmes, compte, bouton Publier.
- `src/app/dashboard/_components/discovery-panel.tsx` — recherche désactivée, widget ΞAgents, placeholders découverte.
- `src/components/page-header.tsx` — header sticky, titre/sous-titre, retour, logo mobile.
- `src/components/xi-logo.tsx` — marque Ξ en SVG minimal à trois traits.
- `src/components/user-avatar.tsx` — résolution d’identité Bloub/photo/fallback.
- `src/components/empty-state.tsx` — états vides du feed et des listes.

## Bloubs

- `src/components/bloub/bloub-avatar.tsx` — avatar circulaire fixe/animé, fond `#e7e9ea`, yeux blancs.
- `src/components/bloub/bloub-preview.tsx` — aperçu grand format, séquence, reduced motion, suivi du curseur.
- `src/components/bloub/bloub-editor.tsx` — tuiles forme/couleur/expression, états, séquences et export SVG.
- `src/components/bloub/labels.ts` — libellés humains des états, formes, expressions, couleurs.
- `src/components/bloub/use-motion.ts` — orchestration mouvement et respect reduced motion.
- `src/components/xiagents/avatar-panel.tsx` — enveloppe métier de l’éditeur dans la page agent.

## Feed et publications

- `src/app/dashboard/page.tsx` — feed principal, onglets « Pour vous »/« Abonnements », explication, composer.
- `src/components/publications/publication-feed.tsx` — chargement serveur, pagination, scope et auteurs.
- `src/components/publications/live-feed.tsx` — rafraîchissement temps réel, nouvelles publications, reprise de scroll, erreurs.
- `src/components/publications/publication-card.tsx` — article feed, badges, contenu, actions Répondre/Partager.
- `src/components/publications/publication-content.tsx` — auteur, messages, résumé, branches, sources, Markdown.
- `src/components/publications/feed-article.tsx` — clic sur zone libre, protection des contrôles internes.
- `src/components/publications/publication-actions.tsx` — composer, bouton publier, répondre, corbeille/restauration.
- `src/components/publications/publication-badges.tsx` — badges brouillon/type/visibilité et dates compactes.
- `src/components/publications/publication-panel.tsx` — sources, versions et contexte d’une publication.
- `src/components/publications/markdown-view.tsx` — rendu Markdown cohérent avec `.xi-markdown`.
- `src/components/publications/message-menu.tsx` — menu de message, partage et actions propriétaire.

## XiAgents

- `src/app/dashboard/xiagents/[id]/page.tsx` — composition et ordre des sections de la page cible.
- `src/components/xiagents/publication-generator.tsx` — génération vérifiée vers brouillon privé.
- `src/components/xiagents/watch-drafts.tsx` — édition, approbation/rejet et publication d’un brouillon.
- `src/components/xiagents/agent-control.tsx` — pause/reprise, exécution ponctuelle, calendrier et profil.
- `src/components/xiagents/schedule/schedule-form.tsx` — onglets et configuration du calendrier.
- `src/components/xiagents/schedule/calendar-editor.tsx` — semaine type, prochaines semaines, exceptions.
- `src/components/xiagents/watch-panel.tsx` — diagnostics de veille, sources, jobs, candidats et paramètres.
- `src/components/xiagents/run-history.tsx` — tableau d’exécutions et pagination.
- `src/components/xiagents/manual-generator.tsx` — outil de fixtures dans une disclosure de développement.
- `src/components/llm/agent-llm-panel.tsx` — résolution et test du modèle par agent.
- `src/components/llm/format.ts` — libellés de résolution, erreurs et classes de select.

## Sources et confiance

- `src/app/dashboard/sources/page.tsx` — page catalogue et bouton Ajouter une source.
- `src/app/dashboard/sources/[sourceId]/page.tsx` — page détail réelle; ce chemin remplace le chemin hypothétique `/dashboard/xiagents/sources/[id]`.
- `src/components/sources/source-trust-list.tsx` — tableau filtrable, matrice de confiance, dialogue de périmètre.
- `src/components/sources/source-detail.tsx` — détail, collecte, confiance, métadonnées, actualités, historique, suppression.
- `src/components/sources/add-source.tsx` — ajout d’une source depuis la page catalogue.

## Primitives UI

- `src/components/ui/button.tsx` — variantes et tailles de boutons.
- `src/components/ui/input.tsx`, `textarea.tsx`, `label.tsx`, `form.tsx` — formulaires.
- `src/components/ui/dialog.tsx`, `dropdown-menu.tsx`, `sheet.tsx` — overlays et navigation secondaire.
- `src/components/ui/card.tsx`, `separator.tsx`, `scroll-area.tsx`, `carousel.tsx` — primitives disponibles mais moins utilisées dans les pages XiAgents/source.
- `src/components/themes/theme-provider.tsx`, `toggle.tsx` — thème clair/sombre/système.

