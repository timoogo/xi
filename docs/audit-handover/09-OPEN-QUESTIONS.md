# Questions ouvertes

Référence `4d333e4a2d1c40670d71f8d7fb6d3771b16d59b2`. Ces questions distinguent décision produit et vérification technique ; elles n'impliquent pas qu'une capacité soit absente.

## Produit et social

- Quel est le contrat minimal des notifications, communautés, mentions et suivi ? Les mentions doivent-elles déclencher une notification ou un agent ? F1-UI-02, F3-08–09.
- Quelles garanties de provenance et de correction doivent être visibles pour un lecteur ? Comment qualifier une mémoire collective suffisante ? F2-03, F2-05–06, F3-04, F3-07.
- Que signifie exactement « terminé » pour chaque capacité reconstruite, et quels parcours sont obligatoires ? [Milestones](05-MILESTONES.md).

## Identités et autorisations

- Quelle procédure locale de récupération de compte et quelle politique de révocation ? F1-AUTH-03 et branches password-reset.
- Quels acteurs et actions doivent être contrôlés par le registre de permissions ou par les stores ? Comment vérifier les refus HTTP et tâches ? R6.
- La validation humaine de Konstruktor lie-t-elle précisément chaque champ appliqué à une proposition sélectionnée ? R7.

## Veille, modèles et diffusion

- Quelle instance Ollama, quels modèles, sources autorisées et données jetables représentent le cas réel à vérifier ? F3-03–06, F5-02.
- Quel niveau d'autonomie est souhaité en développement et en production ; qui autorise publication privée et publique ? R5.
- Quelles limites de qualité, de traçabilité et de non-publication en cas d'erreur doivent être acceptées par le produit ?

## Exploitation et fiabilité

- Quelle est l'origine du `Publication reconciliation failed TypeError` vu en local et en CI ? R1.
- Que doit garantir un handler encore actif après expiration d'un bail ; quels effets exigent une déduplication durable ? R2.
- Quelle procédure de sauvegarde/restauration, récupération entre SQLite et vault et retour arrière de migration est acceptable ? R3–R4.
- Comment le worker est-il démarré et surveillé hors dev ? R8.
- Le build hors ligne est-il une exigence ? Quelle politique pour les téléchargements de polices ?

## Gouvernance

- Un administrateur peut-il confirmer toutes les règles héritées, protections classiques et exceptions de `main` ? Le job navigateur doit-il devenir obligatoire après stabilisation ? R9.
- Le prototype autonome est-il une référence UX, une expérimentation active ou une archive ? Quel usage et quel matériel pour des visuels générés localement ? F6-01–02.
- Existe-t-il des milestones officielles ou décisions historiques non accessibles à l'audit ? Les endpoints correspondants n'étaient pas tous accessibles.
