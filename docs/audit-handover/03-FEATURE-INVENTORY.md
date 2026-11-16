# Inventaire fonctionnel provisoire — phase 3

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Inventaire F1–F6 consolidé et qualifié le 2026-11-06 ; les 47 entrées restent susceptibles d’être scindées après décision produit. Les identifiants ci-dessous sont stables ; les capacités voisines d'autres domaines seront reliées, sans être comptées deux fois.

Statuts de travail selon la mission, à réviser en Q1 après validation : **IMPLÉMENTÉE, NON VALIDÉE**, **PARTIELLE**, **EXPÉRIMENTALE**, **NON DÉTERMINABLE**. La confiance porte sur l'observation et la qualification provisoire, pas sur une garantie de fonctionnement. Aucun statut VALIDÉE n'est attribué en F1. Les descriptions de tests ci-dessous sont les observations initiales ; les résultats ultérieurs, y compris les 431 cas CI historiques et les 329 cas locaux, sont dans `06-VALIDATION-EVIDENCE.md`. La correspondance par fonctionnalité est dans `work/evidence/phase-4-feature-test-matrix.md`.

## F1 — Authentification et comptes humains

### F1-AUTH-01 — Inscription par email et mot de passe

- **Objectif / attendu** : création d'un compte et entrée dans l'espace personnel.
- **Observé** : `/auth/register` utilise `RegisterForm`, validation nom (4 caractères minimum), email, mot de passe de 8 à 128 caractères et confirmation ; la Server Action `Register` appelle `signUpEmail`, puis l'interface redirige vers le dashboard. Better Auth active `autoSignIn` (`src/lib/forms/register.tsx:23`, `src/lib/scheme/auth-scheme.ts:16`, `src/lib/apis/auth.ts:33`, `src/lib/auth.ts:24`).
- **Données / dépendances** : utilisateur et compte Better Auth dans SQLite ; Next.js, Zod, Better Auth. **Historique** : `eeaa686` introduit le socle d'authentification ; voir chronologie H1.
- **Tests / résultat** : `tests/auth.test.ts:15`, `:43`, `:87` décrivent validation et inscription via action avec SQLite temporaire ; CI post-merge rapporte `pnpm test:auth` réussi (`.github/workflows/ci.yml:110` ; preuve H2). La suite CI historique `test:auth` rapporte 13 succès sans skip ; voir 06.
- **Limites** : aucun parcours relancé ici ; configuration réelle et sécurité complète hors périmètre. **Statut provisoire : IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur le chemin statique.

### F1-AUTH-02 — Connexion, session et déconnexion

- **Objectif / attendu** : authentifier l'utilisateur, préserver sa session et lui permettre de sortir.
- **Observé** : formulaire `/auth/login` → `logIn` → `signInEmail` ; `Logout` appelle `signOut` depuis la navigation ; le layout dashboard vérifie la session, tandis que le middleware fait seulement une pré-vérification de cookie (`src/lib/forms/login.tsx:22`, `src/lib/apis/auth.ts:22`, `:45`, `src/app/dashboard/_components/navigation.tsx:46`, `src/lib/current-user.ts:9`, `src/middleware.ts:3`). Session configurée pour 7 jours, sans cache cookie (`src/lib/auth.ts:29`).
- **Données / dépendances** : Better Auth, cookies, SQLite. **Historique** : `eeaa686` ; protection et détail historique dans `04-HISTORICAL-TIMELINE.md`.
- **Tests / résultat** : `tests/auth.test.ts:43` utilise serveur Next.js, SQLite temporaire, redémarrage et scénarios de cookies et isolation ; job CI build/serveur historique réussi ; totaux de suite et skips dans 06. Aucune exécution locale.
- **Limites** : audit exhaustif des sessions et appareils non réalisé. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur raccordement.

### F1-AUTH-03 — Récupération locale de mot de passe

- **Objectif / attendu** : permettre à un administrateur de réinitialiser un mot de passe oublié et guider l'utilisateur.
- **Observé** : aucun équivalent Xi explicite identifié sur `main` après recherche ciblée ; une commande locale, un dialogue et des tests existent sur `clean/password-reset` et `feat/password-reset`, toutes deux à `f971712`, non intégrées à `main` par ascendance. Périmètre et comparaison dans `work/evidence/phase-1-H2-git.md`.
- **Données / dépendances** : Better Auth, compte et sessions SQLite ; état actuel d'éventuelles capacités natives ou procédures indirectes indéterminé. **Historique** : `f1e1825`, `155e8c7`, `c6e5ece`, `f971712`.
- **Tests / résultat** : tests de branche `tests/password-reset.test.ts` et `tests/password-recovery-browser.test.ts`, non exécutés ; leur présence sur la branche ne démontre pas leur succès.
- **Limites** : branche potentiellement récupérable après audit et validation, sans recommandation de merge. **EXPÉRIMENTALE ; confiance élevée** pour le code de branche et sa non-intégration historique ; moyenne sur l'absence d'équivalent produit.

### F1-USER-01 — Profil personnel et paramètres

- **Objectif / attendu** : consulter son identité et accéder à ses paramètres.
- **Observé** : `/dashboard/profile` affiche nom, handle dérivé de l'identifiant, email, avatar et publications ; son lien « Modifier le profil » mène aux paramètres, qui exposent avatar, LLM et format de publication (`src/app/dashboard/profile/page.tsx:10`, `src/app/dashboard/settings/page.tsx:13`, `src/lib/current-user.ts:9`).
- **Données / dépendances** : session Better Auth, préférences avatar SQLite, store de publications ; historique socle `eeaa686`, évolution avatar `7adf862` et `c05ad4a`.
- **Tests / résultat** : `tests/auth.test.ts:107` décrit un contrôle de deux identités, de leur email et de l'accès anonyme ; CI `test:auth` historiquement réussie, cas et skips non détaillés ici.
- **Limites** : le libellé « Modifier le profil » mène à des paramètres, sans formulaire de modification du nom ou de l'email observé sur cette page ; absence d'un autre parcours non établie. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur affichage et destination, moyenne sur les limites globales.

### F1-USER-02 — Découverte de profils et préférences de comptes

- **Objectif / attendu** : trouver des comptes accessibles, consulter leurs profils et régler ses abonnements/préférences.
- **Observé** : `/dashboard/profiles` combine générateurs visibles et auteurs humains issus de publications publiques ou suivis ; un handle unique redirige vers le profil. `/dashboard/profiles/[id]` charge un auteur visible et `AccountControls` (`src/app/dashboard/profiles/page.tsx:10`, `src/app/dashboard/profiles/[id]/page.tsx:9`). La sauvegarde et le comportement du fil seront approfondis en F3.
- **Données / dépendances** : index SQLite de publications, préférences sociales et comptes accessibles ; historique `9deac59`, `d70a31c`.
- **Tests / résultat** : `tests/feed.test.ts` et `tests/e2e.test.ts` à examiner en F3 ; job navigateur historique réussi, sans preuve isolée de chaque parcours.
- **Limites** : catalogue humain limité aux sources de découverte ci-dessus ; pas d'annuaire universel démontré. **IMPLÉMENTÉE, NON VALIDÉE ; confiance moyenne** sur le parcours complet.

## F1 — Comptes éditoriaux et avatars

### F1-ACCOUNT-01 — Proposition et confirmation d'une identité éditoriale

- **Objectif / attendu** : proposer un ΞAgent depuis un Topic puis confirmer explicitement sa création.
- **Observé** : `/dashboard/xiagents` rend `AccountManager` ; `/dashboard/accounts` redirige vers cette page. Le composant crée un run, le reprend puis envoie une confirmation (`src/app/dashboard/xiagents/page.tsx:16`, `src/app/dashboard/accounts/page.tsx:2`, `src/components/accounts/account-manager.tsx:63`). `execute` construit une proposition déterministe sans modèle, attend confirmation ; `confirm` refuse `confirmed=false`, vérifie le propriétaire et persiste (`src/lib/accounts/store.ts:151`, `:180`, `src/app/api/accounts/runs/[id]/route.ts:5`). Le parcours Konstruktor et la création avancée seront inventoriés en F4.
- **Données / dépendances** : Topic existant, presets, fichiers vault et index SQLite ; historique `b3690b7`, transition `d70a31c`.
- **Tests / résultat** : `tests/accounts.test.ts:26`, `:61`, `:77` ; `tests/accounts-browser.test.ts:6` décrit proposition, reprise, confirmation et isolation. CI historique : groupe core et navigateur réussis ; décompte et skips non établis.
- **Limites** : une proposition est déterministe ; ne pas la présenter comme génération IA. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur le chemin d'appel.

### F1-ACCOUNT-02 — Édition et presets versionnés des comptes éditoriaux

- **Objectif / attendu** : modifier une identité et réutiliser des configurations éditoriales.
- **Observé** : le gestionnaire charge `/api/accounts`, propose édition et presets ; `update` contrôle propriétaire et révision, `savePreset` propriétaire et version attendue (`src/components/accounts/account-manager.tsx:19`, `:70`, `src/lib/accounts/store.ts:81`, `:95`, `:123`). Un compte conserve la version de preset choisie ; le parcours complet des paramètres avancés relève aussi de F4.
- **Données / dépendances** : fichiers generator/presets vault, index SQLite, Topic ; historique `b3690b7`, `d70a31c`.
- **Tests / résultat** : `tests/accounts.test.ts:26`, `:47` et `tests/accounts-browser.test.ts:23` ; jobs CI correspondants historiquement réussis, sans résultats de cas indépendants.
- **Limites** : concurrence et reprise à vérifier dans l'environnement de validation. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur le code ciblé.

### F1-AVATAR-01 — Photo de profil humain

- **Objectif / attendu** : importer, remplacer, afficher et retirer une photo.
- **Observé** : paramètres → `AvatarSettings` → PUT/DELETE `/api/account/avatar`, session et origine contrôlées ; `normalizeAvatar` limite JPEG/PNG/WebP, 5 Mio et 16 mégapixels, réencode en WebP 512 et `replaceAvatar` met à jour SQLite et fichiers locaux (`src/components/avatar-settings.tsx:18`, `src/app/api/account/avatar/route.ts:11`, `src/lib/avatars.ts:21`, `:45`, `:76`). GET photo nécessite session et vérifie référence actuelle (`src/app/api/avatars/[file]/route.ts:8`, `src/lib/avatars.ts:101`).
- **Données / dépendances** : champ image Better Auth, dossier d'avatars proche de la base, Sharp. Historique `7adf862`, `c05ad4a`.
- **Tests / résultat** : `tests/avatars.test.ts:8`, `tests/avatars-browser.test.ts:15` couvrent selon leur code les formats et parcours ; CI core/navigateur historiquement réussie, sans logs de cas.
- **Limites** : garanties d'atomicité fichier/base et contrôles d'accès en exécution à vérifier. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur le chemin.

### F1-AVATAR-02 — Choix Bloub ou photo pour un humain

- **Objectif / attendu** : prévisualiser un Bloub, le régénérer et choisir l'avatar affiché.
- **Observé** : `AvatarSettings` prépare une seed et un mode puis envoie PATCH avec révision ; le serveur vérifie session, origine, révision et présence de photo pour le mode photo (`src/components/avatar-settings.tsx:42`, `:57`, `src/app/api/account/avatar/route.ts:30`). Préférences `user_avatar` en SQLite (`src/lib/avatar-preferences.ts:3`), rendu `UserAvatar` (`src/components/user-avatar.tsx:14`).
- **Historique** : `c05ad4a` ; **tests / résultat** : `tests/bloub.test.ts:21`, `tests/bloub-avatar.test.tsx:22`, `tests/avatars-browser.test.ts:15`, CI historique groupes core/navigateur réussis, sans détail des cas.
- **Limites** : apparence humaine basée sur seed ; ne pas la confondre avec le studio agent. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F1-AVATAR-03 — Bloub et état d'activité des ΞAgents

- **Objectif / attendu** : configurer l'apparence d'un agent et représenter son activité.
- **Observé** : page agent → `AvatarPanel` / `BloubEditor` → API avatar propriétaire avec révision (`src/app/dashboard/xiagents/[id]/page.tsx:91`, `src/components/xiagents/avatar-panel.tsx:13`, `src/app/api/xiagents/[id]/avatar/route.ts:4`, `src/lib/accounts/store.ts:233`). `agentActivity` déduit un état de l'activation, veille et jobs sous bail (`src/lib/xiagents/avatar.ts:24`, `:47`) ; `UserAvatar` rend l'identité avec état neutre, ne pas extrapoler l'animation réelle à tous les écrans (`src/components/user-avatar.tsx:14`).
- **Données / dépendances** : configuration de l'agent dans vault, jobs SQLite, `bloub-react` ; historique `c05ad4a`, `8763c6a`.
- **Tests / résultat** : `tests/bloub.test.ts:83`, `:118`, `tests/bloub-avatar.test.tsx:63` ; CI groupe core historiquement réussi, sans résultat individuel vérifié.
- **Limites** : synchronisation des états et parcours visuel à vérifier en navigateur. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** pour les liaisons examinées.

## F1 — Interface transversale

### F1-UI-01 — Navigation et thème

- **Objectif / attendu** : naviguer entre domaines depuis ordinateur ou mobile et choisir le thème.
- **Observé** : `Navigation` présente rail et barre mobile, destinations, menu de compte et sélection clair/sombre/système via `next-themes` (`src/app/dashboard/_components/navigation.tsx:24`, `:42`, `:66`, `:103`, `:136`). Les destinations ne prouvent pas les capacités de chaque page.
- **Données / dépendances** : session utilisateur, Next.js, next-themes ; historique socle `eeaa686`, remaniements `9deac59`, `7adf862`.
- **Tests / résultat** : `tests/accounts-browser.test.ts:50` vérifie un accès au menu mobile ; `tests/auth.test.ts:107` inspecte des pages ; CI navigateur et serveur historiques réussies, sans détail des tests ou preuve d'accessibilité complète.
- **Limites** : responsive, accessibilité clavier et persistance du thème non validés ici. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur la présence de la navigation, moyenne sur son comportement complet.

### F1-UI-02 — Écrans notifications et communautés

- **Objectif / attendu** : présenter des notifications et communautés.
- **Observé** : `/dashboard/notifications` et `/dashboard/communites` affichent explicitement des états indisponibles (`src/app/dashboard/notifications/page.tsx:6`, `src/app/dashboard/communites/page.tsx:6`). La navigation expose les notifications (`src/app/dashboard/_components/navigation.tsx:28`).
- **Données / dépendances** : pages statiques dans le dashboard authentifié ; historique socle `eeaa686`.
- **Tests / résultat** : `tests/auth.test.ts:114` visite les pages et vérifie notamment l'accès authentifié ; CI serveur historique réussie. Aucun test de service de notifications ou communautés associé ici.
- **Limites** : prouve l'état des pages, pas l'absence absolue d'un autre mécanisme. Le texte de la page communautés affirmant qu'on ne peut pas suivre d'autres comptes paraît ancien au vu des contrôles dans `src/app/dashboard/profiles/[id]/page.tsx:22` ; comportement de suivi à tracer en F3. **PARTIELLE ; confiance élevée** pour ces écrans.

## Matrice de traçabilité F1

| Fonctionnalité | Code / entrée | Historique | Tests pertinents | Résultat observé | Statut provisoire |
| --- | --- | --- | --- | --- | --- |
| F1-AUTH-01 | `src/lib/apis/auth.ts:33` | `eeaa686` | `tests/auth.test.ts:87` | CI job serveur réussi ; cas non dépouillés | IMPLÉMENTÉE, NON VALIDÉE |
| F1-AUTH-02 | `src/lib/apis/auth.ts:22` | `eeaa686` | `tests/auth.test.ts:43` | idem | IMPLÉMENTÉE, NON VALIDÉE |
| F1-AUTH-03 | branche `f971712` | `f1e1825`–`f971712` | branche password reset | non exécutés ; non intégrés | EXPÉRIMENTALE |
| F1-USER-01 | `src/app/dashboard/profile/page.tsx:10` | `eeaa686`, `7adf862` | `tests/auth.test.ts:107` | CI job serveur réussi | IMPLÉMENTÉE, NON VALIDÉE |
| F1-USER-02 | `src/app/dashboard/profiles/page.tsx:10` | `9deac59` | `tests/feed.test.ts`, `tests/e2e.test.ts` | suites à examiner en F3 | IMPLÉMENTÉE, NON VALIDÉE |
| F1-ACCOUNT-01 | `src/components/accounts/account-manager.tsx:63` | `b3690b7`, `d70a31c` | `tests/accounts-browser.test.ts:6` | CI navigateur réussi ; détails non extraits | IMPLÉMENTÉE, NON VALIDÉE |
| F1-ACCOUNT-02 | `src/lib/accounts/store.ts:95` | `b3690b7`, `d70a31c` | `tests/accounts.test.ts:47` | CI core réussi ; détails non extraits | IMPLÉMENTÉE, NON VALIDÉE |
| F1-AVATAR-01 | `src/app/api/account/avatar/route.ts:11` | `7adf862`, `c05ad4a` | `tests/avatars.test.ts`, `tests/avatars-browser.test.ts` | CI core/navigateur réussie | IMPLÉMENTÉE, NON VALIDÉE |
| F1-AVATAR-02 | `src/components/avatar-settings.tsx:42` | `c05ad4a` | `tests/bloub.test.ts`, `tests/avatars-browser.test.ts` | CI core/navigateur réussie | IMPLÉMENTÉE, NON VALIDÉE |
| F1-AVATAR-03 | `src/lib/xiagents/avatar.ts:29` | `c05ad4a`, `8763c6a` | `tests/bloub.test.ts:83` | CI core réussie | IMPLÉMENTÉE, NON VALIDÉE |
| F1-UI-01 | `src/app/dashboard/_components/navigation.tsx:24` | `eeaa686`, `9deac59` | `tests/accounts-browser.test.ts:50` | CI navigateur réussie | IMPLÉMENTÉE, NON VALIDÉE |
| F1-UI-02 | `src/app/dashboard/notifications/page.tsx:6` | `eeaa686` | `tests/auth.test.ts:114` | CI serveur réussie ; contenu fonctionnel indisponible | PARTIELLE |

Les noms de tests indiquent des scénarios déclarés, pas leur exécution effective ni leur couverture. `work/evidence/phase-3-F1.md` conserve les pistes de reprise et limites de cette matrice.

## F2 — Topics, recherche, graphe et connaissances

F2 est un inventaire statique provisoire, non une validation ; les tests cités sont présents, non exécutés ici. Les jobs CI historiques `topics` et `graph` sont rapportés réussis en H2, sans décompte ou skips individuels. Chaque entrée inclut objectif, code et chemin d'exécution, données, historique, tests et limites.

### F2-01 — Création et modification de Topics partagés

- **Objectif** : créer un Topic et ses relations après proposition et confirmation humaine ; modifier sa fiche.
- **Observé** : routes `src/app/api/topics/runs/route.ts` et `src/app/api/topics/runs/[id]/route.ts` → `propose`, `resume`, `confirm` ; `src/lib/topics/store.ts:153`, `:210`, `:249`, `:283` ; propriétaire et révision contrôlés, journal de renommage. Données Markdown et index SQLite ; dépendance à la session et au catalogue.
- **Historique/tests** : `b3690b7`, `6fded2a` ; `tests/topics.test.ts:31`, `:53`, `:83`, `:115`. CI historique groupe core réussi ; cas individuels non dépouillés.
- **Limites** : reprises et confirmation non vérifiées ici. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F2-02 — Topics personnels et recherche par tag

- **Objectif** : ouvrir un Topic personnel quand un tag recherché n'existe pas dans le catalogue visible.
- **Observé** : `src/lib/search/server.ts:42` → `openPersonal` (`src/lib/topics/store.ts:347`) lors d'une soumission explicite ; le catalogue partagé gagne sur le personnel ; fichiers privés par utilisateur (`:72`). Dépend de l'identité et des stores de recherche/Topics.
- **Historique/tests** : `6fded2a` ; `tests/personal-topics.test.ts`, `tests/search.test.ts:39` ; CI core historique réussie.
- **Limites** : parcours et isolation à confirmer ; ne pas assimiler toute recherche à une création. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F2-03 — Relations entre Topics et provenance

- **Objectif** : lire, créer, corriger ou masquer des relations personnelles/partagées et leurs preuves.
- **Observé** : page `src/app/dashboard/topics/[tag]/page.tsx:38` → `relationsOf` ; `src/lib/topics/relations.ts:301`, `:335`, `:367`, `:394` distinguent création humaine, proposition, correction et masquage ; filtrage lié à la visibilité et aux preuves. Vault, index et publications accessibles sont nécessaires.
- **Historique/tests** : `6fded2a` ; `tests/topic-relations.test.ts:44`, `:68`, `:89`, `tests/topic-privacy.test.ts:73`. CI core historique réussie.
- **Limites** : provenance et confidentialité effectives à éprouver ; ne pas assimiler cooccurrence et relation validée. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur le code.

### F2-04 — Recherche Topics, agents et publications

- **Objectif** : croiser texte, Topics et agents visibles.
- **Observé** : `src/app/dashboard/explore/page.tsx:31` charge catalogue via `src/lib/search/server.ts:19`, résout requête via `src/lib/search/resolve.ts:82` ; les publications utilisent l'index et FTS (`src/lib/publications/store.ts:850`, `:868`). Session, catalogue et index sont nécessaires ; il s'agit de recherche interne, distincte de la collecte de sources externe.
- **Historique/tests** : `6fded2a` ; `tests/search.test.ts:23`, `tests/search-publications.test.ts:50`. CI core historique réussie.
- **Limites** : pertinence, pagination et droits à confirmer par exécution. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F2-05 — Abonnements et connaissances déclarées par Topic

- **Objectif** : conserver intérêts et connaissances explicites et les afficher dans le réseau.
- **Observé** : `src/lib/search/server.ts:55` et `:60` délèguent abonnements et connaissances ; `src/app/dashboard/graph/page.tsx:29` compose le réseau avec comptes, Topics, relations et publications ; filtres de couches dans `src/lib/topics/network.ts:31`. Données des préférences sociales et index vault/SQLite.
- **Historique/tests** : `6fded2a` ; `tests/topic-network.test.ts:72`, `:101`, `:186`. CI core historique réussie.
- **Limites** : ne prouve pas une mémoire sémantique universelle ; acquisition automatique des connaissances non établie. **IMPLÉMENTÉE, NON VALIDÉE ; confiance moyenne** sur le parcours complet.

### F2-06 — Découverte de concepts et relations issus des publications

- **Objectif** : enrichir les publications et suggérer des concepts/relation avec provenance.
- **Observé** : le worker enregistre `DISCOVERY_JOB` (`scripts/watch-worker.ts:70`, `:84`) ; `src/lib/topics/discovery.ts:241`, `:260`, `:276` planifie et traite des publications, stocke des enregistrements/projections et propose des relations. Sans modèle, termes explicites seulement ; autoaccept dépend de `XI_TOPIC_AUTOACCEPT` (`scripts/watch-worker.ts:74`).
- **Historique/tests** : `6fded2a` ; `tests/topic-discovery.test.ts:104`, `:191`, `:238`. CI historique core réussie ; tests mockés ou réels à distinguer en validation.
- **Limites** : worker et modèle disponibles nécessaires au traitement sémantique ; qualité et provenance réelles non établies. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur branchement conditionnel.

### F2-07 — Graphe des publications et exploration

- **Objectif** : explorer générateurs, publications, messages et relations lisibles.
- **Observé** : API `src/app/api/graph/view/route.ts` et services `src/lib/graph/server.ts:12`, `src/lib/graph/service.ts:30`, `:37`, `:55` → repository `src/lib/graph/repository.ts:186` ; sources vault et index, permissions viewer. Le réseau de Topics est une vue connexe distincte.
- **Historique/tests** : `eeaa686`, `383f8e9` ; `tests/graph-integration.test.ts:258`, `:384`, `tests/graph-security.test.ts:220`. CI historique graph réussie.
- **Limites** : sécurité et exactitude des relations/compteurs restent à tester ; présence du graphe ne prouve pas une mémoire collective complète. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur assemblage.

## F3 — Sources, veille, publications et interactions

Périmètre utilisateur élargi aux publications et interactions prévues au plan initial. Tous les statuts et preuves restent provisoires ; tests non exécutés ici. CI historique `core`, `agents` et navigateur réussie au niveau des jobs, sans garantie individuelle ni preuve d'intégration réelle.

### F3-01 — Catalogue et décisions sur les sources

- **Objectif** : proposer des sources liées aux Topics, consulter et modifier leur état.
- **Code/entrée** : `/dashboard/sources` → `AddSource` / `SourceTrustList` → `/api/watch/sources` ; `createSource` et `updateSource` (`src/lib/watch/source-admin.ts:31`, `:44`), `createSourceStore` (`src/lib/watch/sources.ts:115`, `:178`, `:207`). Statuts proposée, approuvée, refusée, désactivée et supprimée (`:25`) ; sources liées au propriétaire et au vault.
- **Historique/tests** : `e173294`, `8763c6a` ; `tests/watch-source-admin.test.ts:67`, `tests/sources-browser.test.ts` ; CI historique agents/navigateur, détail individuel inconnu.
- **Limites** : collecte de sources proposées permise par `isCollectable` (`sources.ts:86`), distincte d'une approbation pour étayer la publication. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F3-02 — Confiance des sources par portée

- **Objectif** : arbitrer la confiance globale, par agent ou Topic.
- **Code/données** : `src/app/api/watch/trust/route.ts` → `decideTrust` et `trustMatrix` (`src/lib/watch/trust.ts:99`, `:142`) ; refus prioritaire, approbation ou attente (`:46`) ; décisions SQLite, source vault, propriétaire et périmètre. Interface `src/components/sources/source-detail.tsx:75`.
- **Historique/tests** : `8763c6a` ; `tests/watch-trust.test.ts:24`, `:106`, `:174` ; CI historique agents réussie.
- **Limites** : niveau de confiance n'établit pas la véracité d'un article ; résolution et réévaluation à tester. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F3-03 — Collecte et découverte de sources

- **Objectif** : découvrir des flux et collecter des éléments pour les agents actifs.
- **Code/données** : worker `src/lib/watch/worker.ts:167`, `:249` → `planCollection`, `collectHandler`, `discoverHandler` (`src/lib/watch/collect.ts:52`, `:89`, `:197`) ; réseau via `src/lib/watch/net.ts`, flux, état source et articles SQLite. Planification selon agents, sources et calendrier.
- **Historique/tests** : `e173294`, `50d6475` ; `tests/watch-collect.test.ts`, `tests/watch-source-admin.test.ts` ; CI agents historique.
- **Limites** : données et services distants non contactés ; découverte complète et disponibilité réseau non démontrées. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F3-04 — Évaluation des actualités et éléments de preuve

- **Objectif** : regrouper les articles, évaluer pertinence et nouveauté, comparer affirmations et sélectionner une voie éditoriale.
- **Code/données** : `evaluateHandler` (`src/lib/watch/evaluate.ts:414`), `verifyClaims` `:218`, `chooseLane` `:261` ; `src/lib/watch/stories.ts` stocke articles/actualités SQLite ; runtime LLM et confiance source sont des dépendances. Le worker câble le handler (`src/lib/watch/worker.ts:177`).
- **Historique/tests** : `e173294`, `4bdf533`, `8763c6a` ; `tests/watch-evaluate.test.ts`, `tests/watch-trust.test.ts:174`, `tests/integration-pipeline.test.ts:42` ; CI agents historique.
- **Limites** : corroboration automatisée ne certifie pas la vérité ; les mocks et sorties réelles doivent être distingués en validation. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur le raccordement.

### F3-05 — Rédaction et revue de brouillons d'agents

- **Objectif** : produire un brouillon contextualisé et permettre sa revue.
- **Code/données** : `src/lib/watch/drafting.ts:165`, `:291`, `:353` ; génération manuelle `/api/xiagents/[id]/generate` → `src/lib/xiagents/publication-generator.ts:41` exige candidat accepté et modèle ; résultat privé sans publication (`:72`). Stockage vault + candidat SQLite ; dépendances agent actif, sources/Topic et LLM.
- **Historique/tests** : `e173294`, `4bdf533` ; `tests/watch-draft.test.ts`, `tests/xiagents-generation.test.ts`, `tests/integration-pipeline.test.ts:42` ; CI agents historique.
- **Limites** : rendu et conformité des contenus générés restent à prouver ; sorties peuvent être rejetées. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F3-06 — Diffusion éditoriale et autopublication

- **Objectif** : diffuser des contenus admissibles selon politique, calendrier et contrôles.
- **Code/données** : `src/lib/watch/worker.ts:269` → `syncEditorialQueue` (`src/lib/watch/queue.ts:66`) → `createPublisher` / `attempt` / `diffuse` (`src/lib/watch/publisher.ts:138`, `:192`, `:412`) → `publishWatchDraft` (`src/lib/publications/store.ts:577`). Dépend d'un worker, d'un candidat/brouillon, des sources, de l'activation et des drapeaux ; l'Arbitre intervient dans certains cas hors calendrier.
- **Historique/tests** : `e173294`, `8763c6a` ; `tests/watch-publish.test.ts:94`, `tests/editorial-queue.test.ts:115`, `tests/integration-pipeline.test.ts:42`. CI agents historique, cas individuels non vérifiés.
- **Limites** : aucun envoi ni publication exécutés ; garde-fous détaillés A2 ; attention au mode développement. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur conditions statiques.

### F3-07 — Publications humaines, versions et corbeille

- **Objectif** : créer, éditer, publier, corriger et restaurer des contenus Markdown.
- **Code/données** : Server Actions `src/lib/apis/publications.ts:29`, `:41`, `:45`, `:55`, `:64`, correction `src/lib/apis/corrections.ts:8` ; store `src/lib/publications/store.ts:375`, `:670`, `:736`, `:756`, `:787`, `:799`. Vault et index, propriété, révision et visibilité ; analyses publiées signalées immuables et correction séparée.
- **Historique/tests** : `eeaa686`, `9deac59` ; `tests/publications.test.ts:66`, `:115`, `:144`, `:194` ; CI core historique.
- **Limites** : les opérations multi-fichiers et reprise ne sont pas une transaction globale ; parcours réel non exécuté. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F3-08 — Conversations, réponses et mentions

- **Objectif** : consulter une conversation et répondre à un message ; afficher des mentions.
- **Code/données** : `src/lib/apis/publications.ts:35` → `store.create(viewer, messageRef)` (`src/lib/publications/store.ts:375`) ; `conversation` (`:933`), arbre `src/lib/publications/conversation.ts:10`, API `src/app/api/conversations/route.ts:9` ; `remarkMentions` transforme les handles en liens (`src/components/publications/markdown-view.tsx:10`). Vault, index et permissions de lecture.
- **Historique/tests** : `9deac59`, `b781dd4` ; `tests/conversation.test.ts:7`, `tests/xi-conversation-store.test.ts`, `tests/markdown-view.test.tsx` ; CI core historique.
- **Limites** : lien de mention ne démontre ni notification ni déclenchement d'agent ; mention d'Arbitre différente. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur chemins ciblés.

### F3-09 — Abonnements, préférences et fil

- **Objectif** : suivre des comptes, ajuster leur présence et lire les fils.
- **Code/données** : `src/app/dashboard/profiles/[id]/page.tsx:22` → `AccountControls`, endpoint `src/app/api/feed/preferences/route.ts` → `setSocial` (`src/lib/publications/store.ts:1061`) ; accueil (`src/app/dashboard/page.tsx`) et API feed utilisent préférences et permissions (`store.ts:836`). Préférences vault et projections SQLite.
- **Historique/tests** : `9deac59` ; `tests/feed.test.ts`, `tests/e2e.test.ts` ; CI core/navigateur historique.
- **Limites** : confirme des contrôles de suivi, rendant dépassée l'affirmation générale contraire de la page communautés ; expérience complète et classement non validés. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur raccordement.

## F4 — ΞAgents, Konstruktor et Arbitre

Périmètre distingue le formulaire historique F1-ACCOUNT-01, la création avancée et les fonctions système. Les résultats de tests ultérieurs sont consignés dans le registre de validation.

### F4-01 — Création avancée et suggestions de configuration

- **Objectif** : construire un brouillon d'agent/Topic, par saisie, règles ou propositions IA, puis contrôler les champs.
- **Code/entrée** : `src/components/xiagents/create/create-xiagent.tsx` ; `src/lib/xiagents/suggest.ts:162` produit des suggestions déterministes, `src/lib/xiagents/draft.ts:66`, `:77`, `:87`, `:123`, `:165` gère brouillon, modifications, conflits, validations et spec. Dépend de Topics, presets et éventuellement modèle. Le formulaire historique est F1-ACCOUNT-01 ; ne pas compter la publication F3-05 une seconde fois.
- **Historique/tests** : `50d6475`, `a821710` ; `tests/xiagents-creation.test.ts:146`, `:188`, `tests/xiagents-suggest.test.ts:154` ; CI agents historique réussie au niveau job.
- **Limites** : qualité des suggestions et raccordement complet au modèle non vérifiés ici. **IMPLÉMENTÉE, NON VALIDÉE ; confiance moyenne** sur l'ensemble du parcours.

### F4-02 — Déploiement persistant d'agent ou Topic

- **Objectif** : appliquer une configuration confirmée, suivre les étapes et reprendre une interruption.
- **Code/données** : `/api/xiagents/deployments/[id]` → `createDeployments` (`src/lib/xiagents/deployments.ts:185`, `:301`, `:345`) ; preflight, verrou, fichier `.xi-deployments` dans vault, étapes, comptes, Topics, sources et SQLite. `src/app/api/xiagents/deployments/[id]/route.ts:10` lance/reprend séparément.
- **Historique/tests** : `50d6475`, `8763c6a` ; `tests/xiagents-deploy.test.ts:79`, `:119`, `tests/xiagents-deploy-resume.test.ts:31` ; CI agents historique réussie.
- **Limites** : reprise effective et atomicité multi-support à tester ; présence de journal ne prouve pas l'exactly-once. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur code.

### F4-03 — Import et export YAML d'agent

- **Objectif** : transférer une configuration d'agent pour édition et redéploiement.
- **Code/données** : `src/lib/xiagents/yaml.ts:376`, `:480` parse et sérialise ; `/api/xiagents/[id]/export` utilise `exportAgentDraft` et `draftToYaml` (`src/app/api/xiagents/[id]/export/route.ts:13`). Dépend du catalogue Topics, presets, instances et validation du brouillon.
- **Historique/tests** : `50d6475` ; `tests/xiagents-yaml.test.ts:90`, `:167`, `:269`, `tests/xiagents-creation.test.ts:210` ; CI agents historique réussie.
- **Limites** : références externes peuvent nécessiter résolution et confirmation ; ne pas déduire portabilité complète des tests nommés. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur fonctions et export, moyenne sur import UI complet.

### F4-04 — Contrôle et calendrier d'agent

- **Objectif** : configurer la veille et la publication, suspendre/reprendre ou demander une exécution.
- **Code/données** : routes `/api/xiagents/[id]/control`, `/schedule`, `/watch` ; `src/lib/accounts/store.ts:210`, `:317`, `:373`, `:394`, `src/lib/xiagents/schedule.ts:48` ; propriété et révisions, politique vault, jobs SQLite et worker. L'autopublication est décrite F3-06.
- **Historique/tests** : `e173294`, `50d6475`, `8763c6a` ; `tests/xiagents-calendar.test.ts`, `tests/xiagents-orchestrator.test.ts`, `tests/watch.test.ts:215` ; CI agents historique réussie.
- **Limites** : efficacité d'une pause pendant un handler actif et reprise à tester (risque A2). **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F4-05 — Agents système et configuration d'instance

- **Objectif** : présenter et configurer les agents système de l'instance.
- **Code/données** : `src/lib/system-agents/registry.ts:28` déclare Konstruktor et Arbitre ; `src/app/api/system-agents/[kind]/route.ts:7` → `src/lib/system-agents/store.ts:115`, propriétaire d'instance (`src/lib/system-agents/owner.ts:33`) et révision ; état vault, projection SQLite. Page `src/app/dashboard/xiagents/page.tsx:24`.
- **Historique/tests** : `8763c6a` ; `tests/system-agents.test.ts:44`, `:92`, `:119` ; CI agents historique réussie.
- **Limites** : permissions du registre sont déclaratives, pas un moteur d'application démontré (`work/evidence/phase-2-A2-contracts.md`). **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F4-06 — Conversations et propositions de Konstruktor

- **Objectif** : dialoguer sur un agent ou Topic et obtenir des propositions configurables.
- **Code/données** : `/api/konstruktor/sessions` → `createKonstruktor.open/send` (`src/lib/konstruktor/service.ts:67`, `:122`) → tâche système `converse`, modèle, réponse structurée et stockage SQLite (`src/lib/konstruktor/converse.ts:238`, `:247`). Contexte de l'utilisateur et LLM configuré requis.
- **Historique/tests** : `8763c6a` ; `tests/konstruktor.test.ts:10`, `:52`, `:80`, `:132` ; CI agents historique réussie.
- **Limites** : qualité modèle, isolation réelle et disponibilité non démontrées. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F4-07 — Validation et application des propositions Konstruktor

- **Objectif** : revoir, accepter/refuser et appliquer des changements à une cible.
- **Code/données** : `src/lib/konstruktor/service.ts:153`, `:163`, `:176` vérifie IDs et cible, crée déploiement ; son exécution est distincte (F4-02). `src/lib/konstruktor/preview.ts:41` compose l'aperçu ; état SQLite et journal vault.
- **Historique/tests** : `8763c6a` ; `tests/konstruktor-apply.test.ts:33`, `:106`, `:174`, `:213` ; CI agents historique réussie.
- **Limites** : correspondance exacte entre chaque champ de spec et sélection non établie ; préflight et exécution à vérifier. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur branchement, moyenne sur garanties complètes.

### F4-08 — Revues et suggestions proactives de Konstruktor

- **Objectif** : détecter des situations de configuration et proposer des changements à revoir.
- **Code/données** : `src/lib/konstruktor/suggestions.ts:79`, `:281`, `:314` ; `scripts/watch-worker.ts:79` planifie les revues comme tâches système ; `src/lib/konstruktor/service.ts:208`, `:244` expose boîte de suggestions et déclenchement ; comptes, Topics, sources, modèle et SQLite.
- **Historique/tests** : `8763c6a` ; `tests/konstruktor-suggestions.test.ts:53`, `:122`, `:209` ; CI agents historique réussie.
- **Limites** : dépend du worker/modèle ; suggestions ne démontrent pas application automatique. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F4-09 — Arbitrage d'alertes prioritaires

- **Objectif** : décider si une alerte peut essayer une diffusion hors calendrier.
- **Code/données** : `src/lib/watch/publisher.ts:359` → `src/lib/arbiter/arbitration.ts:145` met en file une mention interne persistée → `src/lib/arbiter/decide.ts:42` → verdict ; contrôle final côté publisher `:284`. SQLite, agent système activé, tâche et modèle ; sans verdict favorable retour au circuit normal selon conditions.
- **Historique/tests** : `8763c6a` ; `tests/arbiter.test.ts:34`, `:100`, `:196`, `:235` ; CI agents historique réussie.
- **Limites** : Arbitre ne publie pas lui-même ; qualité des décisions et parcours en panne non vérifiés ici. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F4-10 — Supervision des agents et de la file

- **Objectif** : lire activité, calendrier et file éditoriale par propriétaire.
- **Code/données** : `src/lib/xiagents/supervision.ts:108`, `:171`, `:231`, `:263`, route `src/app/api/xiagents/supervision/route.ts` ; agrégations d'exécutions, décisions, candidats et files SQLite ; filtres par utilisateur.
- **Historique/tests** : `8763c6a` ; `tests/supervision.test.ts:54`, `:134`, `:170`, `tests/supervision-browser.test.ts` ; CI agents/navigateur historique réussie.
- **Limites** : observabilité des erreurs et isolation réelle restent à tester. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur projections.

## F5 — IA locale, orchestration et infrastructure fonctionnelle

### F5-01 — Configuration d'instances et choix de modèle

- **Objectif** : configurer une instance et choisir modèle global ou par agent.
- **Code/données** : page paramètres `src/app/dashboard/settings/page.tsx:13` → `LLMSettings`, routes `/api/llm/instances`, `/api/llm/settings` et `/api/xiagents/[id]/llm` ; `src/lib/llm/store.ts:53`, `:69`, `:97` ; `src/lib/llm/resolve.ts:18` choisit agent, défaut utilisateur puis serveur opérateur, sans repli silencieux après sélection invalide. SQLite, configuration utilisateur, agent et environnement.
- **Historique/tests** : `4bdf533` ; `tests/llm-config.test.ts:60`, `:90`, `:122`, `tests/llm-ui.test.tsx:53` ; CI core historique réussie au niveau du job.
- **Limites** : configuration réelle inconnue, aucune connexion. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F5-02 — Inférence Ollama et API compatible OpenAI

- **Objectif** : appeler un modèle configuré et exposer des contrôles de connectivité.
- **Code/données** : `src/lib/llm/server.ts:40`, `:74`, `:81`, `:102` ; `src/lib/llm/ollama.ts:98`, `src/lib/watch/inference.ts:43`, `:58`, politique de destinations `src/lib/llm/network.ts:38`, `:60`. Compatible Ollama ou API de chat OpenAI côté serveur d'environnement ; autorisation explicite d'adresses possible, donc local-first ne signifie pas nécessairement même machine. Dépend du réseau et d'un modèle disponible.
- **Historique/tests** : `4bdf533` ; `tests/llm-ollama.test.ts:50`, `:74`, `tests/llm-integration.test.ts:112`, `tests/llm-config.test.ts:244` ; CI core historique.
- **Limites** : `tests/llm-ollama.test.ts:50` utilise `fakeOllama`, non une instance réelle ; aucun modèle réel interrogé ici. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur le code, aucune preuve runtime.

### F5-03 — File persistante, priorités et reprise

- **Objectif** : planifier, dédupliquer et reprendre des tâches.
- **Code/données** : `src/lib/watch/jobs.ts:22`, `:80`, `:106`, `:138`, `:153`, `:159`, `:170` ; SQLite `watch_job`, clés, baux, jetons et retries ; `src/lib/watch/orchestrator.ts:28` définit types et limites ; `src/lib/watch/worker.ts:51` exécute.
- **Historique/tests** : `e173294`, `8763c6a` ; `tests/watch.test.ts:118`, `:176`, `tests/xiagents-orchestrator.test.ts:36`, `tests/system-agent-tasks.test.ts:109` ; CI agents historique.
- **Limites** : clé réutilisable après purge ; mécanisme d'interruption `Promise.race` sans annulation démontrée, effets des handlers à vérifier (A2). **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F5-04 — Exécution et reprise des tâches système

- **Objectif** : traiter des demandes persistées par utilisateur avec limites et résultats observables.
- **Code/données** : `/api/system-agents/[kind]/tasks` → `src/lib/system-agents/tasks.ts:87`, `:108`, `:128`, `:170` ; file SQLite, processus web ou worker, registre de tâches, contexte utilisateur et modèle ; attente bornée en cas de modèle indisponible.
- **Historique/tests** : `8763c6a` ; `tests/system-agent-tasks.test.ts:59`, `:86`, `:109`, `:138` ; CI agents historique.
- **Limites** : sans processus actif ou nouvelle requête, aucune reprise immédiate garantie ; ne pas compter une seconde fois les fonctionnalités F4 de Konstruktor et Arbitre. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F5-05 — Worker périodique, état et diagnostic

- **Objectif** : planifier et exécuter des passes de veille et suivre leur état.
- **Code/données** : `scripts/watch-worker.ts:38` → `src/lib/watch/worker.ts:209`, `:320` ; `scripts/watch-dev.ts:20` lance périodiquement en développement ; exemple de timer externe `docs/watch.md:737`, non preuve d'installation. Jobs et historique SQLite, vault, sources externes, modèle ; arrêt par `XI_WATCH_DISABLED`.
- **Historique/tests** : `e173294`, `a821710`, `8763c6a` ; `tests/watch.test.ts:262`, `tests/watch-events.test.ts:67` ; CI agents historique.
- **Limites** : infrastructure de production réelle inconnue ; ne pas lancer sur des données réelles en validation. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur les scripts.

### F5-06 — Synchronisation et événements temps réel

- **Objectif** : actualiser les vues de publications et réconcilier les changements du vault.
- **Code/données** : `src/app/api/events/route.ts:20` obtient la session et émet SSE avec réconciliation, puis revérifie la session (`:68`) ; watcher et réconciliation `src/lib/publications/runtime.ts:11`, `:73` ; base d'index et fichiers vault.
- **Historique/tests** : `9deac59`, `785f4e6`, `3b2ee59` ; `tests/realtime-events.test.ts:5`, `:20`, `tests/server-shutdown.test.ts:11` ; CI core et serveur historique.
- **Limites** : perte d'événements, permissions évolutives et arrêt effectifs à tester. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée**.

### F5-07 — Migration et vérification sur copie

- **Objectif** : initialiser les schémas et permettre une répétition de migration sur copie.
- **Code/données** : `scripts/migrate-auth.ts:6` et `src/lib/maintenance/migration-check.ts:36`, `:73` ; copie SQLite/vault, contrôles et reconstruction d'index ; scripts déclarés dans `package.json:12`. Voir les distinctions et la contradiction documentaire en A2.
- **Historique/tests** : `eeaa686`, `8763c6a` ; `tests/migration-copy.test.ts:33`, `:61` ; suite `test:watch` dans CI agents historique.
- **Limites** : aucune migration ou répétition exécutée ; rollback et sécurité de chaque version non établis. **IMPLÉMENTÉE, NON VALIDÉE ; confiance élevée** sur code, pas sur absence de perte.

## F6 — Prototype et vision non couverte

### F6-01 — Prototype autonome d'interface ΞAgent

- **Objectif** : explorer une interface de gestion des agents et sources.
- **Code/entrée** : `prototypes/v0-xiagent/app/page.tsx:1` rend `AgentDashboard` (`prototypes/v0-xiagent/components/xi-dashboard.tsx:7`, `:31`) avec libellé « Démo UX », états locaux et données simulées ; `xi-workspace.tsx:32` contient d'autres données statiques. Package et lockfile distincts ; recherche ciblée dans `src`, `package.json`, README et docs n'a trouvé aucun import vers le prototype.
- **Historique/tests** : `a821710` ajoute le prototype ; pas de test de ce prototype identifié en F6 et aucune exécution.
- **Limites** : existence de fonctions équivalentes dans le produit ne démontre pas intégration de cette maquette ; recherche ciblée, pas preuve absolue d'absence de réutilisation indirecte. **EXPÉRIMENTALE ; confiance élevée** sur données simulées, moyenne sur non-intégration.

### F6-02 — Génération locale de représentations visuelles

- **Objectif** : enrichir à terme les contenus par des visuels générés localement, selon le contexte produit de la mission ; aucun critère détaillé de réalisation disponible.
- **Code/données** : recherche ciblée `git grep` des termes Stable Diffusion, ComfyUI, image generation, génération d'images, imagegen, text-to-image et diffusers dans `src`, `scripts`, docs, README et manifeste sans résultat pertinent. L'existence d'avatars Bloub, de photos et du diffuseur éditorial ne constitue pas une génération d'images.
- **Historique/tests** : recherche ciblée de messages de commits avec image/visual/visuel ; correspondances relevées concernent images de publication ou avatars, pas preuve d'un moteur de génération. Aucun test pertinent identifié.
- **Limites** : vision fournie par la mission, non preuve de spécification formalisée dans le dépôt ; recherche non exhaustive des synonymes ou dépendances indirectes. **PLANIFIÉE ; confiance moyenne** sur le statut de vision, faible sur l'absence d'implémentation cachée.

## État consolidé après F1–F6

Les entrées détaillées et leur statut provisoire forment la matrice fonctionnelle pour les domaines examinés. Pour F2–F6, chaque bloc fournit directement la relation **fonctionnalité → code/entrée → historique → tests → résultat/limites → statut** ; les résultats locaux et les totaux historiques par suite sont conservés en 06 et dans les matrices de preuves. Cet inventaire est un premier périmètre reconstruit, susceptible d'être scindé ou complété selon les décisions produit ; il ne démontre pas une couverture exhaustive de toutes les variantes et endpoints.

- F1 : 12 entrées ; F2 : 7 ; F3 : 9 ; F4 : 10 ; F5 : 7 ; F6 : 2. Total **47 entrées**, dont **43 IMPLÉMENTÉES, NON VALIDÉES**, **2 EXPÉRIMENTALES**, **1 PARTIELLE**, **1 PLANIFIÉE** ; aucune VALIDÉE à ce stade.
- Les tests de pipeline `tests/integration-pipeline.test.ts:42` utilisent un modèle et des flux doublés ; `tests/llm-ollama.test.ts:50` utilise `fakeOllama`. Les succès CI historiques cités dans les lots portent sur les jobs et ne certifient pas les parcours réels.
- Priorités pour V1/V2 : assurer l'isolation base/vault/réseau ; relever les résultats et skips ; vérifier session et droits ; exercer reprise et effets d'un handler interrompu ; vérifier un parcours de source à brouillon avec doubles clairement identifiés puis, si disponible et sûr, les intégrations réelles ; vérifier les règles de publication sans diffuser sur les données réelles.
- Points à compléter en Q1 : cohérence de spec/choix Konstruktor, notifications éventuelles de mentions, preuve du mode d'exploitation du worker, garanties de rollback et d'atomicité vault/SQLite, liens fonctionnels d'import YAML, périmètre réel des capacités visuelles.


## Qualification consolidée — phases 4 et 5

Au vu des preuves complétées, les statuts ci-dessus sont conservés : **43 IMPLÉMENTÉES, NON VALIDÉES ; 2 EXPÉRIMENTALES ; 1 PARTIELLE ; 1 PLANIFIÉE ; 0 VALIDÉE**. Cette qualification s'applique au périmètre complet de chaque entrée, non à chacun de ses scénarios : de nombreux scénarios unitaires, de stockage, navigateur et serveurs ont réussi ; leurs preuves figurent dans `06-VALIDATION-EVIDENCE.md` et `work/evidence/phase-4-feature-test-matrix.md`. Les intitulés « à tester » dans les observations historiques désignent les garanties complètes restantes, et non l'absence de tout test réussi.

Aucune entrée ne satisfait encore de façon démontrée tous les critères de clôture de son périmètre reconstruit, notamment lorsque celui-ci inclut configurations et intégrations réelles, droits de bout en bout, ou garanties de panne. Ce jugement prudent ne signifie pas que les 43 fonctionnalités échouent. Niveau de confiance : élevé sur les états expérimental du reset et du prototype et partiel des écrans ; moyen sur l'absence d'un moteur visuel caché et sur la complétude fonctionnelle de chaque entrée. Références de code, historique et limites spécifiques figurent dans chaque bloc ; résultats et types de test dans la matrice de correspondance. Les hypothèses et critères à décider sont dans `09-OPEN-QUESTIONS.md` et `05-MILESTONES.md`.
