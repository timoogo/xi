# Palette de commandes (Cmdly)

Palette ouverte par **Ctrl+K / ⌘+K**, le bouton « Commandes » du rail de navigation (tablette et ordinateur) ou la bulle flottante au Bloub (partout ; sur mobile, à gauche du bouton de rédaction, ou à sa place dans l'éditeur). Tous ouvrent la même palette, donc un seul moteur Cmdly. Moteur : [`@cmdly/core`](https://github.com/timoogo/cmdly), abonnement React : `@cmdly/react`.

## Organisation

```
src/lib/commands/
  types.ts             NavigationRuntime : navigate(href) + pathname, seul contrat avec l'hôte
  registry.ts          registre racine : monte les registres des modules, assemble le runtime navigateur
src/lib/<module>/commands/
  index.ts             runtime déclaré par le module, type <Module>Command, registre du module
  <commande>.ts        une commande par fichier
  client.ts            services du runtime en navigateur, via les routes API existantes
src/components/commands/command-menu.tsx   palette générique (aucune commande n'y est nommée), état d'ouverture et raccourci
src/components/commands/command-bubble.tsx bulle flottante (Bloub `CMDLY_BLOUB_CONFIG`) ; sa position est fixée par la navigation
src/components/bloub/use-companion.ts      vie du Bloub de la bulle (humeur, regard, écouteurs posés sur la bulle seule)
src/lib/bloub/companion.ts                 contrôleur sans React ni DOM : humeurs, direction du regard, minuteries
```

### Le Bloub de la bulle

bloub-react fournit la vie de base : clignements, dérive et saccades du regard, respiration, fondu entre expressions. Ξ ne pilote que la **direction du regard** (script `gaze`) et l'**expression** :

- au repos, il regarde vers la page (à gauche, la bulle étant à droite), avec de petits coups d'œil irréguliers (toutes les 6 à 15 s) qui reviennent toujours au repos ;
- au survol (souris ou stylet) ou au focus clavier, il devient attentif (`attentif`) et suit le pointeur ; ensuite il revient progressivement au repos ;
- au clic, il sourit brièvement (`heureux`) ; la palette s'ouvre dans le même événement, sans délai ;
- sans interaction, il se calme au bout de 30 s (`somnolent`), puis 90 s plus tard il s'endort : image fixe, plus de boucle d'animation. Toute interaction le réveille.

Pas d'écouteur global : les gestionnaires sont posés sur la bulle seule. La boucle d'animation ne tourne que si la bulle est visible, l'onglet actif et le mouvement accepté. Avec `prefers-reduced-motion`, l'image reste fixe, tournée vers la page.

Limite de bloub-react 1.0.0 : l'intervalle des clignements (1,9 à 4,6 s, parfois doublés) n'est pas réglable par l'API publique.

- **Un module possède ses commandes.** Son `index.ts` déclare le runtime dont elles ont besoin (`PublicationCommandRuntime`, `XiAgentCommandRuntime`) et les enregistre avec `registerMany`.
- **La racine ne fait que composer** : `xiCommands.mount("publications", publicationCommands)`. Les identifiants deviennent `publications.find`, `xiagents.find`… Cmdly refuse un namespace ou un identifiant en double. Le runtime racine (`XiCommandRuntime`) est l'intersection des runtimes des modules : TypeScript refuse de monter un module dont les besoins ne sont pas couverts.
- **Aucune dépendance cachée.** Une commande reçoit `{ runtime }` en paramètre : navigation et services. Elle n'importe ni Next.js, ni React, ni `fetch`. Les tests remplacent le runtime par des services en mémoire (`tests/commands.test.ts`).
- **Permissions.** Les services appellent les routes existantes (`/api/feed`, `/api/xiagents`), qui appliquent les droits du lecteur. Masquer une commande (`when`) n'autorise jamais rien.
- **La palette est générique.** Elle affiche l'état du moteur : menu, étape, progression, chargement, erreur avec « Réessayer », résultats vides, confirmation finale. Échap ou Retour arrière (champ vide) reviennent à l'étape précédente ; Échap au menu ferme. Un moteur Cmdly ne se rouvre pas après fermeture : chaque ouverture en crée un, détruit à la fermeture.

## Commandes

| Identifiant | Libellé | Étapes |
|---|---|---|
| `publications.go-to` | Aller aux publications | aucune ; masquée sur `/dashboard/publications` |
| `publications.find` | Rechercher une publication | portée (mes publications et brouillons / fil récent) → publication → ouverture |
| `xiagents.find` | Rechercher un ΞAgent | ΞAgent (éditoriaux possédés et système) → sa page |
| `xiagents.create-publication` | Créer une publication pour un ΞAgent | ΞAgent éditorial possédé → `#publication-generator` de sa page (section dépliée) |

Les listes de publications reprennent la **première page** (20 éléments) de l'API paginée du fil. La palette les filtre ensuite par libellé (voir les limites).

## Ajouter une commande

Exemple : « Ouvrir la corbeille » dans le module Publications.

1. Créer `src/lib/publications/commands/open-trash.ts` :

   ```ts
   import type { PublicationCommand } from ".";

   export const openTrash = {
     id: "open-trash",
     label: "Ouvrir la corbeille",
     run: (_answers, { runtime }) => runtime.navigate("/dashboard/publications/trash"),
   } satisfies PublicationCommand;
   ```

2. L'ajouter à la liste du module, dans `src/lib/publications/commands/index.ts` : `publicationCommands.registerMany([goToPublications, findPublication, openTrash]);`

Rien d'autre à modifier : ni la racine, ni la palette. Une étape dynamique déclare `options: async (answers, { runtime }) => …`. Un service supplémentaire s'ajoute au runtime du module et à son `client.ts`. Pour un **nouveau module**, créer `src/lib/<module>/commands/index.ts` sur le même modèle, puis ajouter une ligne `mount` et son runtime à l'intersection dans `registry.ts`.

## Limites connues (Cmdly 0.1.1)

- Les chargeurs d'options ne reçoivent pas le texte saisi. Le filtrage se fait côté client sur les options chargées : pas de recherche serveur à la frappe.
- `Answers` ne conserve que les valeurs. Le résumé d'une étape finale afficherait donc des identifiants, pas des libellés : aucune commande n'utilise d'étape finale.
- `CommandPalette` (de `@cmdly/react`) n'accepte pas de registre. La palette de Ξ est donc construite sur `useCommandEngine`.
- Depuis la 0.1.1, les paquets se chargent aussi par `require()` (condition `default`, Node ≥ 20.19 ou ≥ 22.12) : les tests unitaires, chargés en CommonJS par `tsx`, n’ont plus besoin d’option particulière.

## Vérification

`pnpm test:commands` (moteur et registres, sans navigateur) et `pnpm test:commands:e2e` (palette réelle, build de production requis).
