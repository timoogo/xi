# Configuration ΞAgent en YAML (format `xiagent` v1)

Un ΞAgent (ou un topic seul) peut être décrit dans un fichier YAML lisible, versionné et portable.
Le fichier est l'une des trois entrées du parcours de création (suggestion, import YAML, saisie
manuelle) : il ne fait **que pré-remplir le brouillon** (`AgentDraft`, `src/lib/xiagents/draft.ts`).
Rien n'est déployé à l'import : le propriétaire relit, complète, puis lance le déploiement
habituel, que le serveur valide de nouveau (`deploymentSpecSchema`). Il n'existe pas de pipeline de
déploiement propre au YAML.

- Code : `src/lib/xiagents/yaml.ts` (`parseAgentYaml`, `draftToYaml`, exécutable dans le navigateur),
  `src/lib/xiagents/export.ts` (`exportAgentDraft`, côté serveur).
- Export : `GET /api/xiagents/<id>/export` (propriétaire uniquement ; 401 sans session, 404 pour
  l'agent d'un autre propriétaire) renvoie `<handle>.xiagent.yaml` en pièce jointe.

## Exemple complet

```yaml
# Configuration ΞAgent — format xiagent v1 (docs/xiagent-yaml.md)

xiagent: 1                       # version du format (obligatoire)
kind: agent                      # agent | topic (défaut : agent)
identity:
  name: Veille exoplanètes
  handle: exoplanetes            # le @ initial est accepté
  description: Découvertes et caractérisation d’exoplanètes.
topics:
  primary:                       # nouveau topic (étiquette absente du catalogue)
    tag: astronomie.exoplanetes
    name: Exoplanètes
    scope: Détection et caractérisation des exoplanètes
    description: Mondes en orbite autour d’autres étoiles.
    parent: astronomie           # étiquette d’un topic existant
    related: [ science ]         # étiquettes de topics existants
  secondary: [ science, astronomie.telescopes ]   # étiquettes existantes ou sections
editorial:
  perimeter: Publications scientifiques et annonces des agences spatiales.
  charter: |-
    Toujours citer l’étude primaire.
    Distinguer annonce et résultat évalué par les pairs.
style:
  preset: pedagogue@1            # <id>@<version> ou <id> (dernière version)
  tone: Accessible, explicatif, progressif
  audience: Grand public
  structure: Notions, explication progressive, exemples
  depth: standard                # court | standard | approfondi
  model: qwen3:8b                # référence du modèle local (facultatif)
sources:
  - url: https://arxiv.example/astro-ph
    type: prépublications
    rationale: Source primaire
    status: approved             # redevient « à décider » à l’import
  - url: https://blog.example/
    status: excluded
  - https://nasa.example/feed    # forme courte : URL seule
schedule:
  timeZone: Europe/Paris         # fuseau IANA
  watch:                         # quand la veille peut travailler
    week:
      lundi: [ 07:00-23:00 ]
      mardi: [ 07:00-12:00, 22:00-02:00 ]   # 22:00-02:00 se termine le lendemain
      mercredi: [ 07:00-23:00 ]
      jeudi: [ 07:00-23:00 ]
      vendredi: [ 07:00-23:00 ]
      samedi: []
      dimanche: [ 00:00-24:00 ]
    exceptions:
      "2026-12-25": []           # jour fermé
  publish:                       # quand la publication est permise
    week: [ [ 03:00-06:00 ], [ 03:00-06:00 ], [ 03:00-06:00 ], [ 03:00-06:00 ], [ 03:00-06:00 ], [], [] ]
    exceptions: {}
  graceMinutes: 30               # 0–240
  catchUpHours: 72               # 0–168
  majorEvents: false             # ou { enabled: false }
  retentionDays: null            # 1–365, null = réglage global
publication:
  autoPublish: false
appearance:                      # identifiants du catalogue Bloub
  shape: cercle
  expression: neutre
  color: bleu
```

## Schéma

| Clé | Type | Règles |
| --- | --- | --- |
| `xiagent` | entier | Obligatoire. Absent → erreur ; autre entier que `1` → « version incompatible ». |
| `kind` | `agent` \| `topic` | Défaut `agent`. `topic` : seul `topics.primary` (un nouveau topic) est lu, les autres sections sont ignorées avec un avertissement. |
| `identity.name` | texte | 1–160 caractères. |
| `identity.handle` | texte | Minuscules, chiffres, tirets, points ; `@` initial retiré. |
| `identity.description` | texte | 4 000 caractères au plus. |
| `topics.primary` | étiquette ou section | Obligatoire si `topics` est présent. |
| `topics.secondary` | liste d'étiquettes ou de sections | 30 au plus (31 topics en tout). |
| section de topic | `tag`, `name`, `scope`, `description`, `parent`, `related` | Voir « Topics ». |
| `editorial.perimeter`, `editorial.charter` | texte | 4 000 caractères au plus chacun. |
| `style.preset` | `<id>@<version>` ou `<id>` | Preset inconnu ici → avertissement, preset du brouillon conservé, réglages importés. |
| `style.tone`, `style.audience` | texte | 1–300 caractères. |
| `style.structure` | texte | 1–1 000 caractères. |
| `style.depth` | `court` \| `standard` \| `approfondi` | |
| `style.model` | texte | 200 caractères au plus. |
| `sources` | liste (URL ou section `url`, `type`, `rationale`, `status`) | 50 au plus ; URL http(s) sans identifiants ; `type` ≤ 80, `rationale` ≤ 500 ; `status` : `approved`, `excluded` ou `undecided` (défaut). |
| `schedule.timeZone` | fuseau IANA | Absent → `Europe/Paris` (avertissement). |
| `schedule.watch`, `schedule.publish` | calendrier | `week` (jours `lundi` … `dimanche`, ou liste de 7 jours, lundi en premier) et `exceptions` (`"AAAA-MM-JJ": [plages]`, 400 au plus). |
| plage | `"HH:MM-HH:MM"` | Début 00:00–23:59, fin 00:01–24:00 (`00:00` en fin vaut `24:00`) ; fin ≤ début : se termine le lendemain ; 24 plages par jour au plus. |
| `schedule.graceMinutes` | entier | 0–240. |
| `schedule.catchUpHours` | entier | 0–168. |
| `schedule.majorEvents` | booléen ou `{ enabled }` | |
| `schedule.retentionDays` | entier ou `null` | 1–365. |
| `publication.autoPublish` | booléen | Les garde-fous de l'opérateur (`XI_WATCH_AUTOPUBLISH`) s'appliquent toujours. |
| `appearance.shape`, `.expression`, `.color` | identifiant Bloub | Clés absentes : apparence par défaut. |

### Configurations partielles

Toutes les sections sont facultatives (sauf `xiagent`) : une clé absente n'est pas importée et le
brouillon garde sa valeur (défaut ou suggestion). À l'intérieur d'une section :

- `style` sans les quatre réglages : complétés par le preset indiqué (ou le preset par défaut), avec un avertissement ;
- `schedule` : les valeurs absentes viennent du calendrier par défaut (veille 07:00–23:00, publication
  03:00–06:00, tolérance 30 min, rattrapage 72 h) ; dans une semaine décrite par jours, **un jour absent
  est fermé** ;
- `appearance` : les identifiants absents prennent la valeur par défaut.

### Topics

- Une **étiquette** (`science`, ou section avec `tag`) qui correspond à une étiquette ou à un alias du
  catalogue désigne le topic existant (détails éventuels ignorés, avec un avertissement).
- Une **étiquette seule** inconnue du catalogue est une **référence non résolue** : elle est conservée à
  sa place (jamais supprimée, jamais remplacée par un autre topic), signalée par un avertissement, et
  bloque le déploiement tant que le propriétaire ne l'a pas remplacée par un topic existant, créée comme
  nouveau topic ou retirée (un topic secondaire seulement : le principal se remplace). Seul
  `kind: topic` crée directement le topic nommé par une étiquette seule.
- Une **section** (`{ tag, name, scope, … }`) dont l'étiquette est inconnue définit un **nouveau topic**,
  créé au déploiement. `name` absent → dérivé du dernier segment de l'étiquette ; `scope` absent →
  périmètre générique ; dans les deux cas un avertissement demande de vérifier. Sans `parent`, une
  étiquette hiérarchique (`science.exoplanetes`) est rattachée au topic de son préfixe s'il existe.
- `parent` et `related` désignent des topics existants par étiquette ; inconnus → avertissement
  (topic créé sans parent, lien ignoré).
- Un topic en double est ignoré (avertissement).

### Sources

Les sources importées ne sont **jamais approuvées automatiquement** : `approved` devient « à décider »
(un avertissement demande de les réapprouver), `excluded` reste exclue, l'origine est `yaml`. Les
exclusions importées sont listées dans la synthèse d'import et dans la section Sources de l'éditeur
(ouverte d'office), avec leur provenance ; elles survivent aux modifications, aux suggestions et aux
exports, et ne sont levées que par un choix explicite du propriétaire (« Approuver » ou « Ne pas
décider »). Les
sources « à décider » ne sont pas déployées. Une source dont un champ est invalide est ignorée en entier ;
un domaine déjà présent est ignoré.

## Erreurs et avertissements

`parseAgentYaml(text, { catalog, presets })` ne lève jamais d'exception et renvoie :

- `{ ok: false, issues }` quand le fichier est refusé en entier : vide, plus de 64 ko, syntaxe
  invalide (ligne et colonne indiquées), clé en double, plusieurs documents, étiquette YAML
  personnalisée (`!tag`, `!!js/function`, …), trop d'alias (> 20, protection contre les « bombes »
  d'alias), structure trop profonde, racine qui n'est pas une section, version absente ou incompatible,
  `kind` inconnu ;
- `{ ok: true, target, patch, issues }` sinon. Chaque champ invalide produit une **erreur** localisée
  (`path`, ex. `schedule.watch.week.lundi[0]`, `sources[2].url`) et n'est pas importé ; chaque clé
  inconnue produit un **avertissement** et est ignorée.

Le `patch` s'applique comme une suggestion : `applySuggestion(draft, patch, "yaml")` — les champs déjà
modifiés à la main par le propriétaire ne sont pas écrasés.

Sécurité de l'analyse : schéma YAML `core` (aucun type personnalisé), aucune étiquette explicite
acceptée, alias bornés, taille, profondeur et longueurs de listes bornées. Le contenu n'est jamais
exécuté ni évalué.

## Export, portabilité et duplication

`draftToYaml(draft, catalog)` produit un fichier à l'ordre de clés stable, avec l'en-tête ci-dessus.
Il ne contient **aucun identifiant interne ni secret** : ni identifiant d'agent, de topic, de
déploiement ou de révision, ni propriétaire, ni publications, ni historique d'exécution, ni réglages
internes de la politique de veille (seul `autoPublish` est exporté). Les topics sont référencés par
étiquette, les presets par `<id>@<version>`, les sources par URL. Les dates d'exception sont entre
guillemets pour rester lisibles par les outils YAML 1.1.

L'export d'un agent existant (`exportAgentDraft`) reprend : nom, handle, description ; topics
principal et secondaires ; périmètre et charte ; preset, réglages et modèle ; calendriers (s'ils sont
explicites et valides, sinon le calendrier par défaut) ; `autoPublish` ; apparence Bloub ; et les
sources du propriétaire rattachées aux topics de l'agent (approuvées → `approved`, rejetées →
`excluded`).

Les topics sont exportés **à leur place, ou pas du tout** : un topic introuvable dans le catalogue
n'est jamais omis (un topic secondaire deviendrait principal). Une référence non résolue dont
l'étiquette est connue est exportée telle quelle ; si l'étiquette est inconnue (topic disparu du
catalogue, connu seulement par son identifiant), l'export est refusé (erreur 409 explicite) plutôt que
de produire un fichier qui modifierait le périmètre de l'agent.

Aller-retour : pour chaque champ exporté, export → import → `applySuggestion` redonne le même brouillon,
à deux exceptions près, voulues : les sources `approved` reviennent « à décider » et leur origine
devient `yaml`.

**Dupliquer un ΞAgent = exporter puis importer** : la copie est un nouveau déploiement (choisir un autre
handle), sans aucun historique (publications, exécutions, révisions), et ses sources doivent être
réapprouvées.
