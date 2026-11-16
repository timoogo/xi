# Relations sémantiques de Konstruktor

Relations entre les concepts que Konstruktor extrait des publications d'un ΞAgent (`src/lib/konstruktor/`), stockées
comme relations personnelles du propriétaire (`docs/topic-relations.md`). Aucune nouvelle structure de stockage.

## Modèle

Une relation = un **type structurel** existant (`related_to`, `similar_to`, `part_of`, `influences`, `opposes`)
+ pour chaque preuve, le **libellé sémantique** : les mots exacts de la phrase.

| Champ de la preuve | Contenu |
|---|---|
| `excerpt` | phrase de la publication, trouvée par le code (jamais recopiée par le modèle) |
| `publication` | publication d'origine ; l'ΞAgent est son auteur |
| `label` | mots du texte entre les deux concepts (« successfully completed a flight of », « est un ») |
| `subject` | concept que la phrase nomme en premier : le libellé se lit `subject — label → autre` |
| `explicit` | `true` si la vérification déterministe ci-dessous a réussi |

Pas d'énumération par verbe : « développe », « explore », « est un » restent du texte, sous un type `related_to`
quand rien d'autre n'est établi. La direction lisible vient de `subject`, pas de l'ordre de stockage (normalisé pour
les types symétriques).

## Écartée, proposée ou validée

Écartée (`screenKnowledge`) : concept absent du texte, lien hors des deux concepts, lien réduit à des articles,
prépositions ou conjonctions (« et », « entre »), attribution (« selon »), coordination entre les deux concepts,
**autre concept retenu entre les deux** (« NASA test pilot Mike Lippert completed a flight of the X-59 » ne relie pas
NASA au X-59).

Validée automatiquement (`explicitLink`) seulement si **toutes** ces conditions tiennent :

1. Les deux concepts sont nommés dans la phrase citée, `from` avant `to` : le sens du modèle est celui de la phrase.
2. Entre eux, il n'y a que les mots du lien, précédés au plus d'auxiliaires ou d'adverbes (« a », « has »,
   « successfully ») et suivis au plus d'articles. Aucun autre nom, aucune virgule, parenthèse ou tiret.
3. Le lien contient un mot propre (pas seulement articles ou prépositions), ni conjonction ni relatif.
4. Le premier concept est le sujet : ni complément (« la caméra de la NASA ») ni possesseur (« NASA's rover »).
5. Aucune négation, hypothèse, modalité ou intention dans la phrase (« ne… pas », « n't », « pourrait », « will »,
   « prévoit », « si »…), et pas de question.
6. Un type orienté n'est retenu qu'avec son indice dans la phrase, sans inversion.
7. Aucune décision humaine sur la paire de concepts.

Le libellé validé est l'empan exact de la phrase, de l'auxiliaire au dernier mot du lien. La confiance déclarée par
le modèle n'intervient jamais. Sinon : proposition, avec le motif dans le journal du pipeline.

## Priorité

Décision humaine > validation automatique > proposition du modèle.

- Une validation automatique est inscrite dans l'historique par l'auteur `konstruktor:validation`
  (`AUTO_VALIDATOR`) ; toute autre décision (correction de type, validation, exclusion, restauration) est humaine
  (`humanDecision`).
- Exclusion ou correction d'un type : jamais reproposées. Décision humaine sur une autre relation de la paire : les
  nouvelles relations restent proposées.
- Confirmer une relation validée automatiquement l'inscrit comme décision humaine. Tout reste réversible
  explicitement : retype, restauration après exclusion.
- Réanalyse d'une publication : ses preuves que la nouvelle analyse ne donne plus sont retirées des relations
  automatiques (`retractPublication`) ; une validation automatique sans preuve explicite restante redevient
  proposition, tracée (`reproposed`). Les relations décidées par un humain gardent tout.
- Une preuve identique déjà enregistrée sans vérification est remplacée par sa version vérifiée : anciennes
  relations compatibles, sans doublon.

## Graphe → Connaissances

- Statut **par ΞAgent** : décision humaine si elle existe (vaut pour tous) ; sinon validée seulement si les preuves de
  cet agent sont explicites. Une relation validée par un agent reste proposée pour un autre, et dans la vue de cet
  autre agent seul.
- Arête : trait plein épais (confirmée/corrigée par vous), tirets longs (validée automatiquement), tirets courts
  orange (proposée), pointillés (exclue, sur demande). Survol : « Mike Lippert — successfully completed a flight of →
  X-59 · Validée automatiquement ».
- Panneau de relation : phrase, statut, preuves et statut de chaque ΞAgent, preuve explicite signalée.

## Limites

- Règles lexicales français/anglais, sans analyse syntaxique : prudentes, elles laissent en proposition des relations
  vraies (« a capturé une image de la région » si le modèle ne donne que « capturé »).
- Une phrase négative chez un ΞAgent n'empêche pas la validation par la phrase affirmative d'un autre : elle reste
  visible comme preuve proposée et dans les libellés.
- La qualité des concepts (« accord », « flight ») dépend encore du modèle et du filtre de concepts existant.
