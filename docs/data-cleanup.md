# Nettoyage des données de démonstration

## Audit avant modification

- `src/lib/dummy-data/pages.ts` : profils, handles, biographies, avatars et couvertures Unsplash, compteurs de followers/following.
- `src/lib/dummy-data/tweets.ts` : publications, auteurs, notifications d’interactions, dates et compteurs inventés.
- `src/lib/dummy-data/trending.ts` : tendances et volumes de publications fictifs.
- `dashboard/_components/side-bar.tsx` : identité fixe `pages[0]`, faux compteurs et bouton de publication.
- `dashboard/profile/_components/createTweet.tsx` : fil fictif, compteurs et pagination simulée.
- `dashboard/profile/_components/StoryPage.tsx` : carrousel automatique de stories fictives.
- `dashboard/profile/_components/Trending.tsx`, `dashboard/_components/SubFollwers.tsx` et `Peoples.tsx` : tendances, suggestions, profils tiers et boutons Follow sans action.
- `dashboard/notifications/_components/notifications.tsx` : fausses notifications, délais et chargement infini simulés.
- `dashboard/profile/_components/PostTweet.tsx` : annonce de publication réussie sans aucune persistance.
- `lib/forms/login.tsx` : lien de récupération de mot de passe pointant vers l’inscription.
- `dashboard/about-us/_components/About-us.tsx` : coordonnées et image de l’auteur du dépôt d’origine présentées comme celles de Xi.
- Accueil, métadonnées et conditions : promesses de conversations, partage, tendances et politique de confidentialité absents du MVP.

## Résultat et limites

L’identité affichée est celle de la session Better Auth, lue côté serveur et partagée uniquement pendant la requête React. Seuls nom, email, image et identifiant dérivé de l’ID du compte sont transmis au profil privé et à la navigation. Aucun paramètre de route ne permet de choisir un autre compte. L’email n’apparaît dans aucun annuaire public ; il reste dans l’espace authentifié de son propriétaire.

Les données de démonstration et les stories sont supprimées. Le fil est vide. Les zones tendances et suggestions restent des cartes statiques explicitement indisponibles. Les routes historiques communautés et notifications restent protégées et affichent un état d’indisponibilité ; elles ne sont plus proposées comme fonctions actives dans la navigation.

La carte de publication `PublicationCard` est conservée dans `createTweet.tsx`, sans compteurs ni actions fictives. `PostTweet` conserve une présentation de composition désactivée, non montée dans l’interface. Aucun contenu n’est créé et aucun backend social n’est ajouté.

Le thème, les routes d’authentification, le profil privé, À propos, les informations d’utilisation et la déconnexion sont conservés. Better Auth, SQLite et les migrations restent inchangés. Les tests HTTP utilisent deux comptes réels distincts dans une base temporaire pour vérifier le rendu privé, l’isolation et les sessions.
