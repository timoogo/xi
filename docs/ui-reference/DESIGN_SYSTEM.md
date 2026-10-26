# Système visuel réellement utilisé par Ξ

Ce document décrit l’interface telle qu’elle existe dans le dépôt. Il ne constitue pas une proposition de nouveau design system. Les valeurs et les exceptions ci-dessous sont donc à préserver ou à challenger explicitement.

## Cadre général

- Application Next.js rendue en français (`<html lang="fr">`), avec Geist et Geist Mono chargées via `next/font/google`.
- Tailwind CSS v4 et `tw-animate-css`; les composants UI locaux sont principalement des wrappers Radix + `class-variance-authority`.
- Le dashboard est une composition à trois zones centrée sur `max-w-[1265px]` : rail gauche, colonne centrale de `max-w-[640px]`, panneau de découverte à droite (`320px`, puis `350px` en `xl`).
- Le rail est une colonne fixe de `72px` jusqu’à `xl`, puis `275px` avec labels. Sur mobile il devient une barre fixe basse avec safe area et un menu Sheet.
- La colonne centrale est bordée verticalement à partir de `sm`; les sections sont séparées par `border-b` et remplies le plus souvent par `p-4`.
- Les pages utilisent un header sticky commun de `min-h-[53px]`, fond semi-opaque et flou (`bg-background/85 backdrop-blur-md`), avec titre `text-xl font-bold`.

## Couleurs et tokens

Les tokens sont définis dans `src/app/globals.css` en OKLCH et exposés à Tailwind :

| Token | Clair | Sombre | Usage observé |
|---|---|---|---|
| `background` | `oklch(1 0 0)` | `oklch(0.145 0 0)` | fond global |
| `foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | texte principal |
| `card` | blanc | `oklch(0.205 0 0)` | cartes UI génériques |
| `primary` | `oklch(0.205 0 0)` | `oklch(0.922 0 0)` | boutons principaux |
| `secondary`, `muted`, `accent` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | surfaces et survols |
| `muted-foreground` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` | aide, métadonnées |
| `border`, `input` | `oklch(0.922 0 0)` | transparence blanche 10–15% | séparateurs et champs |
| `destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | erreurs, suppression |
| `ring` | `oklch(0.708 0 0)` | `oklch(0.556 0 0)` | focus |
| `chart-2` | `oklch(0.6 0.118 184.704)` | `oklch(0.696 0.17 162.48)` | liens/CTA du feed (`text-chart-2`) |

Le rayon de base est `0.625rem`; les variantes sont calculées en `sm`, `md`, `lg`, `xl`. Les arrondis ne sont pas uniformes : `rounded-full` pour navigation, avatars et CTA sociaux, `rounded-md` pour champs/boutons, `rounded-lg` pour panneaux et dialogues, `rounded-xl/2xl` pour certaines surfaces de découverte et l’aperçu Bloub.

### Exception publications

Les publications appliquent `.xi-publication` : fond `#000`, texte `#e7e9ea`, bordure `#2f3336`, muted `#16181c`, texte secondaire `#91989e`, accent/lien `#58b6f5`. Cette surface sombre reste locale au feed et ne doit pas être généralisée au dashboard.

## Typographie

- Geist sans-serif partout; Geist Mono pour les zones de code/Markdown.
- Corps courant Tailwind par défaut; feed compact en `text-[15px] leading-6`, publication détaillée en `text-[17px] leading-7`.
- Titres de section XiAgent/source : `text-lg font-bold`; titres de page : `text-xl font-bold`.
- Navigation : labels `text-xl`, éléments actifs `font-bold`; métadonnées souvent `text-sm`, `text-xs` ou `text-[13px]`.
- Le Markdown rendu a une hauteur de ligne `1.65`, puis des règles locales pour titres, listes, citations, code, tableaux et liens.

## Espacement, surfaces et densité

- Rythmes dominants : `gap-2`, `gap-3`, `gap-4`, `space-y-3/4`; sections principales `p-4`.
- Tables et listes ont des séparateurs fins (`border-b`, `divide-y`) plutôt que des cartes flottantes.
- Les formulaires utilisent des groupes compacts, des `fieldset`, labels au-dessus et champs `h-9` / padding horizontal `px-3`.
- Les états secondaires sont souvent du texte inline sous le contrôle (`text-xs text-muted-foreground`) plutôt que des badges colorés.
- Les textes longs sont explicitement cassés (`break-words`, `break-all`, `overflow-wrap:anywhere`).

## Composants et interactions

- `Button` local : variantes `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`; tailles `default`, `sm`, `lg`, `icon`; focus visible en anneau de `3px`.
- `Input`, `Textarea`, `Dialog`, `DropdownMenu`, `Sheet`, `Separator`, `ScrollArea`, `Card` sont les primitives partagées.
- Les actions asynchrones désactivent le contrôle et affichent un texte d’attente (« Enregistrement… », « Chargement… »), puis une notice `role=status` ou une erreur `role=alert`.
- Les confirmations sensibles sont inline ou dans `Dialog` (suppression de source, suppression d’instance, publication publique).
- Les divulgations sont souvent natives (`details/summary`) : historique, détails de collecte, outils de test, réglages avancés.
- Le feed est social : toute la zone libre d’un article est cliquable, mais liens, boutons, sélections et contrôles gardent leur comportement.
- Le feed vivant affiche une barre « Nouvelles publications », conserve la position au rafraîchissement et propose « Afficher plus de publications ».
- Focus clavier : `focus-visible:ring`, liens soulignés au survol; skip link « Aller au contenu » au dashboard.
- Le thème est `light/dark/system` via `next-themes`; ne pas supposer une interface exclusivement claire ou sombre.

## Bloubs et identité

- Un Bloub est l’avatar identitaire principal de Ξ. `UserAvatar` choisit dans l’ordre : configuration Bloub de l’agent, Bloub dérivé d’un seed humain, image sûre (`https` ou chemin local), puis Bloub par défaut.
- Le rendu est un SVG `bloub-react`, recadré dans un cercle avec fond `#e7e9ea`; les yeux restent blancs (`#ffffff`).
- L’identité est toujours rendue en état neutre `idle`; l’activité réelle d’un ΞAgent est séparée de son avatar de profil.
- L’éditeur Bloub est un studio dense : aperçu, états, séquence, lecture/pause, suivi du curseur, export SVG, puis groupes Forme/Couleur/Expression sous forme de tuiles sélectionnables.
- Le mouvement respecte `prefers-reduced-motion`; les vignettes sont des images fixes.

## Incohérences à conserver dans la référence

- Mélange de composants `Card` et de simples `section` bordées; les pages XiAgents/sources utilisent surtout les secondes.
- Mélange de boutons arrondis (`rounded-full` dans la navigation/feed) et carrés (`rounded-md` dans les formulaires).
- Certains sélecteurs sont des `<select>` natifs avec classes locales, d’autres contrôles passent par Radix.
- Les états de confiance utilisent des couleurs sémantiques vert/gris/rouge; les publications utilisent une esthétique sombre et bleue distincte.
- Les espaces de développement et diagnostics sont présents dans la page de production sous `details`.

