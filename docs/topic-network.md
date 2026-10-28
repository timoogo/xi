# Réseau des Topics

Second mode de la page `/dashboard/graph` (`?view=topics`), à côté de l’« Arbre actuel » (générateurs → publications → messages), qui reste inchangé : son état (disposition, filtres, dépliages, vue) reste dans IndexedDB et n’est pas touché par le changement de mode. L’état du réseau est dans l’URL (`layers`, `focus`, `open`, `proposed`), donc partageable et compatible avec le bouton Retour.

## Nœuds, arêtes, couches

- **Nœuds** : des topics visibles par le lecteur (`topics.visible` : catalogue commun et ses propres topics personnels).
- **Arêtes** (`relations.networkEdges`) : hiérarchie (`parentId`), relations déclarées dans les fiches (`relatedIds`), relations enregistrées **validées** (communes via `readableStructure`, personnelles du lecteur). Les propositions ne sont servies que sur demande (`proposed=1`) et seulement à qui peut les valider ; elles sont en pointillés. Les relations exclues, les exclusions personnelles du lecteur et les relations reposant uniquement sur des publications illisibles ne sont jamais envoyées. Une cooccurrence n’est jamais une arête. Aucune justification, preuve ni extrait n’est transmis : ils restent sur la fiche du topic, soumis aux règles du lot 5.
- **Couches** superposables, chacune amorçant la vue indépendamment :
  - *Mes connaissances* : liste explicite `knowledge` de `posts/_users/<id>/feed.md`, modifiée uniquement par l’action « Ajouter à / Retirer de mes connaissances » (fiche topic ou panneau du réseau). Lire, rechercher, consulter ou s’abonner n’y ajoute rien.
  - *Mes centres d’intérêt* : abonnements (`topics` du même fichier).
  - *ΞAgents experts* : ΞAgents visibles (`accounts.list` : publics ou à soi). On distingue la spécialité déclarée (topic principal / secondaires) des contributions : nombre de publications réelles (hors fixtures `test_content`) de l’agent, déclarées sur le topic et **lisibles par le lecteur** (`readablePublicationSql`). Un agent privé d’un autre utilisateur n’apparaît jamais ; un agent devenu privé disparaît aussitôt.

## Lisibilité et exploration progressive

`NETWORK_LIMITS` (`src/lib/topics/network.ts`) : 40 topics de départ, 16 voisins par exploration, 12 explorations, 150 nœuds. Le catalogue complet n’est jamais envoyé : seuls les nœuds affichés et leurs arêtes. Chaque nœud indique ses voisins non affichés (« +n ») ; « Explorer ses voisins » les ajoute, « Replier » les retire. Les positions sont déterministes (hash de l’id) et les nœuds déjà placés bougent à peine quand on en ajoute.

## Accessibilité

Nœuds focusables (Tab), Entrée/Espace pour sélectionner, flèches pour aller au topic le plus proche dans une direction ; panneau de détail qui reçoit le focus ; liste textuelle des topics et relations (bouton « Liste ») ; libellés pour lecteurs d’écran ; contrôles de 36 px ; panneau en feuille basse sur mobile. Le panoramique et la molette n’agissent que dans le canevas ; la page a une hauteur fixe et ne défile pas.

## Fichiers

`src/lib/topics/network.ts` (types, requête, URL, libellés — partagé client/serveur), `src/lib/topics/network-data.ts` (construction serveur), `src/components/graph/topic-network.tsx` et `topic-network-layout.ts` (vue), `src/app/dashboard/graph/page.tsx` (sélecteur de mode). Tests : `tests/topic-network.test.ts`, `tests/topic-network-browser.test.ts`.
