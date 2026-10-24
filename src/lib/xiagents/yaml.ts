import { Document, isScalar, parseDocument, visit } from "yaml";
import { accountDraftSchema, profileSchema, settingsSchema, type Preset, type Settings } from "../accounts/types";
import { DEFAULT_BLOUB_CONFIG, bloubConfigSchema } from "../bloub/config";
import type { BloubConfig } from "../bloub/types";
import { draftSchema, tagSchema, TopicError, type Draft, type Topic } from "../topics/types";
import { DAY_MINUTES, formatTime, isoDateSchema, parseTime, timeRangeSchema, type Calendar, type TimeRange } from "./calendar";
import { newTopicKey, presetKey, type AgentDraft, type DraftPatch, type SourceRow, type Target, type TopicPick } from "./draft";
import { defaultSchedule, scheduleSchema, type Schedule } from "./schedule";

/**
 * Portable YAML form of an `AgentDraft` (docs/xiagent-yaml.md). Client-safe: it runs in the
 * creation dialog. An import only produces a `DraftPatch` applied as a suggestion
 * (`applySuggestion(draft, patch, "yaml")`): it never deploys anything by itself, the regular
 * deployment pipeline validates the resulting draft again on the server.
 *
 * Safety: size limit, YAML core schema (no custom types), explicit tags refused, alias expansion
 * bounded, depth and list lengths bounded; values are only read, never executed.
 * Portability: no internal identifier is written — topics are referenced by tag, presets by
 * `<id>@<version>`, sources by URL. Imported sources are never approved automatically.
 */
export const AGENT_YAML_VERSION = 1;
export const MAX_YAML_BYTES = 64_000;
export type YamlIssue = { level: "error" | "warning"; path: string; message: string };
export type YamlImport = { ok: true; target: Target; patch: DraftPatch; issues: YamlIssue[] } | { ok: false; issues: YamlIssue[] };

const HEADER = " Configuration ΞAgent — format xiagent v1 (docs/xiagent-yaml.md)";
const DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const;
const MAX_DEPTH = 8;
const MAX_TOPICS = 31;
const MAX_SOURCES = 50;
const MAX_EXCEPTIONS = 400;
const MAX_RANGES = 24;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: Obj, key: string) => Object.hasOwn(value, key) ? value[key] : undefined;
const at = (path: string, key: string | number) => typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;

function depth(value: unknown, level = 0): number {
  if (level > MAX_DEPTH) return level;
  if (Array.isArray(value)) return Math.max(level, ...value.map(item => depth(item, level + 1)));
  if (isObj(value)) return Math.max(level, ...Object.values(value).map(item => depth(item, level + 1)));
  return level;
}

// ---------------------------------------------------------------- import

class Reader {
  issues: YamlIssue[] = [];
  error(path: string, message: string) { this.issues.push({ level: "error", path, message }); }
  warn(path: string, message: string) { this.issues.push({ level: "warning", path, message }); }
  /** Mapping at `path` (absent → undefined; wrong type → error); unknown keys are reported. */
  section(value: unknown, path: string, keys: readonly string[]): Obj | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isObj(value)) { this.error(path, "Section attendue (clés: valeurs)."); return undefined; }
    for (const key of Object.keys(value)) if (!keys.includes(key)) this.warn(at(path, key), `Clé inconnue « ${key} » : ignorée.`);
    return value;
  }
  string(value: unknown, path: string, check?: { safeParse(value: unknown): { success: boolean } }, message = "Valeur invalide."): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "number" || typeof value === "boolean") value = String(value);
    if (typeof value !== "string") { this.error(path, "Texte attendu."); return undefined; }
    if (check && !check.safeParse(value).success) { this.error(path, message); return undefined; }
    return value;
  }
  boolean(value: unknown, path: string): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") { this.error(path, "Valeur attendue : true ou false."); return undefined; }
    return value;
  }
  integer(value: unknown, path: string, min: number, max: number): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) { this.error(path, `Entier attendu entre ${min} et ${max}.`); return undefined; }
    return value;
  }
  list(value: unknown, path: string, max: number, label: string): unknown[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) { this.error(path, "Liste attendue."); return undefined; }
    if (value.length > max) { this.error(path, `${max} ${label} au plus.`); return undefined; }
    return value;
  }
}

const shape = accountDraftSchema.shape;
const maxLength = (max: number) => ({ safeParse: (value: unknown) => ({ success: String(value).trim().length <= max }) });
const titleFromTag = (tag: string) => { const last = tag.split(".").at(-1)!.replace(/-/g, " "); return last.charAt(0).toUpperCase() + last.slice(1); };
const findTag = (catalog: Topic[], tag: string) => catalog.find(topic => topic.tag === tag) ?? catalog.find(topic => topic.aliases.includes(tag));

function entryObject(r: Reader, entry: unknown, path: string, keys: readonly string[], scalarKey: string, label: string): Obj | undefined {
  if (typeof entry === "string") return { [scalarKey]: entry };
  if (isObj(entry)) return r.section(entry, path, keys);
  r.error(path, `${label} attendu(e) : texte ou section.`);
  return undefined;
}

function readTopics(r: Reader, value: unknown, catalog: Topic[], target: Target): TopicPick[] | undefined {
  const section = r.section(value, "topics", ["primary", "secondary"]);
  if (!section) return undefined;
  if (own(section, "primary") === undefined || own(section, "primary") === null) { r.error("topics.primary", "Topic principal requis lorsque la section topics est présente."); return undefined; }
  if (target === "topic" && own(section, "secondary") !== undefined) r.warn("topics.secondary", "Ignoré pour kind: topic.");
  const secondary = target === "topic" ? [] : r.list(own(section, "secondary"), "topics.secondary", MAX_TOPICS - 1, "topics secondaires");
  if (secondary === undefined && own(section, "secondary") !== undefined && own(section, "secondary") !== null) return undefined;
  const picks: TopicPick[] = [];
  const seen = new Set<string>();
  const entries: [unknown, string][] = [[own(section, "primary"), "topics.primary"], ...(secondary ?? []).map((item, index) => [item, at("topics.secondary", index)] as [unknown, string])];
  for (const [entry, path] of entries) {
    // A bare tag unknown to the catalog is a reference, not a definition: kept unresolved, never created implicitly.
    const pick: TopicPick | undefined = target === "agent" && typeof entry === "string" && tagSchema.safeParse(entry).success && !findTag(catalog, entry)
      ? (r.warn(path, `Topic ${entry} introuvable dans le catalogue : référence conservée, à remplacer, créer ou retirer avant le déploiement.`), { type: "unresolved", tag: entry, id: null })
      : readTopic(r, entry, path, catalog, picks);
    // The order defines the primary topic: without it the list is meaningless.
    if (!pick) { if (path === "topics.primary") return undefined; continue; }
    const id = pick.type === "existing" ? pick.id : pick.type === "new" ? `new:${pick.draft.tag}` : `new:${pick.tag}`;
    if (seen.has(id)) { r.warn(path, "Topic en double : ignoré."); continue; }
    seen.add(id);
    picks.push(pick);
  }
  if (target === "topic" && picks[0].type !== "new") { r.error("topics.primary", "kind: topic attend un nouveau topic (étiquette absente du catalogue)."); return undefined; }
  return picks;
}

function readTopic(r: Reader, entry: unknown, path: string, catalog: Topic[], taken: TopicPick[]): TopicPick | undefined {
  const object = entryObject(r, entry, path, ["tag", "name", "scope", "description", "parent", "related"], "tag", "Topic");
  if (!object) return undefined;
  const tag = r.string(own(object, "tag"), at(path, "tag"), tagSchema, "Étiquette invalide : minuscules, chiffres, tirets, points pour la hiérarchie.");
  if (tag === undefined) { if (own(object, "tag") === undefined || own(object, "tag") === null) r.error(at(path, "tag"), "Étiquette requise."); return undefined; }
  const existing = findTag(catalog, tag);
  const detailed = Object.keys(object).some(key => key !== "tag");
  if (existing) {
    if (detailed) r.warn(path, `Le topic ${tag} existe déjà : le topic existant est utilisé, ses détails sont ignorés.`);
    return { type: "existing", id: existing.id };
  }
  const name = r.string(own(object, "name"), at(path, "name"), draftSchema.shape.name, "Nom invalide (160 caractères au plus).");
  const scope = r.string(own(object, "scope"), at(path, "scope"), draftSchema.shape.scope, "Périmètre invalide (4 000 caractères au plus).");
  const description = r.string(own(object, "description"), at(path, "description"), draftSchema.shape.description, "Description trop longue (4 000 caractères au plus).");
  const draft: Draft = { tag, name: name?.trim() || titleFromTag(tag), scope: scope?.trim() || "", description: description?.trim() ?? "", parentId: null, relatedIds: [] };
  if (!draft.scope) draft.scope = `Actualités, travaux et analyses relevant de « ${draft.name} ».`;
  if (!name?.trim() || !scope?.trim()) r.warn(path, `Nouveau topic ${tag} : ${[!name?.trim() && "nom", !scope?.trim() && "périmètre"].filter(Boolean).join(" et ")} complété(s) automatiquement, à vérifier.`);
  const parent = r.string(own(object, "parent"), at(path, "parent"), tagSchema, "Étiquette de parent invalide.");
  if (parent !== undefined) {
    const found = findTag(catalog, parent);
    if (found) draft.parentId = found.id;
    else r.warn(at(path, "parent"), `Parent ${parent} introuvable dans le catalogue : topic créé sans parent.`);
  } else if (tag.includes(".")) {
    // A dotted tag names its parent: the store requires it to exist and be linked.
    const found = findTag(catalog, tag.split(".").slice(0, -1).join("."));
    if (found) draft.parentId = found.id;
  }
  const related = r.list(own(object, "related"), at(path, "related"), 30, "topics liés");
  for (const [index, item] of (related ?? []).entries()) {
    const relatedTag = r.string(item, at(at(path, "related"), index), tagSchema, "Étiquette invalide.");
    if (relatedTag === undefined) continue;
    const found = findTag(catalog, relatedTag);
    if (!found) r.warn(at(at(path, "related"), index), `Topic lié ${relatedTag} introuvable : ignoré.`);
    else if (!draft.relatedIds.includes(found.id)) draft.relatedIds.push(found.id);
  }
  if (!draftSchema.safeParse(draft).success) { r.error(path, `Topic ${tag} invalide.`); return undefined; }
  return { type: "new", key: newTopicKey(taken), draft };
}

function readStyle(r: Reader, value: unknown, presets: Preset[], patch: DraftPatch) {
  const section = r.section(value, "style", ["preset", "tone", "audience", "structure", "depth", "model"]);
  if (!section) return;
  const ref = r.string(own(section, "preset"), "style.preset", undefined);
  let preset: Preset | undefined;
  if (ref !== undefined) {
    const match = /^([^@:\s]+)(?:[@:](\d+))?$/.exec(ref.trim());
    if (!match) r.error("style.preset", "Preset attendu sous la forme <id>@<version> ou <id>.");
    else {
      const candidates = presets.filter(item => item.id === match[1]);
      preset = match[2] ? candidates.find(item => item.version === Number(match[2])) : candidates.sort((a, b) => b.version - a.version)[0];
      if (preset) patch.presetKey = presetKey(preset);
      else r.warn("style.preset", `Preset ${ref} inconnu ici : le preset actuel est conservé, les réglages fournis sont importés.`);
    }
  }
  const fields = settingsSchema.shape;
  const given: Partial<Settings> = {};
  for (const key of ["tone", "audience", "structure"] as const) {
    const text = r.string(own(section, key), at("style", key), fields[key], key === "structure" ? "Structure invalide (1 000 caractères au plus, non vide)." : "Valeur invalide (300 caractères au plus, non vide).");
    if (text !== undefined) given[key] = text.trim();
  }
  const depthValue = r.string(own(section, "depth"), "style.depth", fields.depth, "Profondeur attendue : court, standard ou approfondi.");
  if (depthValue !== undefined) given.depth = depthValue as Settings["depth"];
  if (Object.keys(given).length) {
    const base = preset?.settings ?? presets[0]?.settings;
    const complete = (["tone", "audience", "structure", "depth"] as const).every(key => given[key] !== undefined);
    if (!complete && !base) r.error("style", "Réglages incomplets : ton, public, structure et profondeur sont requis.");
    else {
      if (!complete) r.warn("style", `Réglages absents complétés avec le preset ${preset ? preset.name : `par défaut (${presets[0].name})`}.`);
      patch.settings = { ...base!, ...given };
    }
  } else if (preset) patch.settings = preset.settings;
  const model = r.string(own(section, "model"), "style.model", maxLength(200), "Référence de modèle trop longue (200 caractères au plus).");
  if (model !== undefined) patch.modelRef = model.trim();
}

function readSources(r: Reader, value: unknown): SourceRow[] | undefined {
  const list = r.list(value, "sources", MAX_SOURCES, "sources");
  if (!list) return undefined;
  const rows: SourceRow[] = [];
  let reapprove = 0;
  for (const [index, entry] of list.entries()) {
    const path = at("sources", index);
    const object = entryObject(r, entry, path, ["url", "type", "rationale", "status"], "url", "Source");
    const before = r.issues.filter(issue => issue.level === "error").length;
    if (!object) continue;
    const raw = r.string(own(object, "url"), at(path, "url"));
    if (raw === undefined) { if (own(object, "url") === undefined) r.error(at(path, "url"), "URL requise."); continue; }
    let url: URL;
    try { url = new URL(raw.trim()); } catch { r.error(at(path, "url"), "URL invalide."); continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2_000) { r.error(at(path, "url"), "URL http(s) attendue, sans identifiants."); continue; }
    const type = r.string(own(object, "type"), at(path, "type"), maxLength(80), "Type trop long (80 caractères au plus).");
    const rationale = r.string(own(object, "rationale"), at(path, "rationale"), maxLength(500), "Justification trop longue (500 caractères au plus).");
    const status = r.string(own(object, "status"), at(path, "status"), { safeParse: (v: unknown) => ({ success: ["approved", "excluded", "undecided"].includes(String(v)) }) }, "Statut attendu : approved, excluded ou undecided.");
    // A row with an invalid field is left out entirely.
    if (r.issues.filter(issue => issue.level === "error").length !== before) continue;
    if (rows.some(row => row.domain === url.hostname)) { r.warn(path, `Domaine ${url.hostname} déjà présent : source ignorée.`); continue; }
    if (status === "approved") reapprove++;
    rows.push({ url: url.href, domain: url.hostname, type: type?.trim() ?? "", rationale: rationale?.trim() ?? "", origin: "yaml", status: status === "excluded" ? "excluded" : "undecided" });
  }
  if (list.length && !rows.length) return undefined;
  if (reapprove) r.warn("sources", `${reapprove} source(s) approuvée(s) dans le fichier : à réapprouver avant le déploiement (jamais approuvées automatiquement).`);
  return rows;
}

function readRange(r: Reader, value: unknown, path: string): TimeRange | undefined {
  if (typeof value !== "string") { r.error(path, "Plage attendue sous la forme \"HH:MM-HH:MM\"."); return undefined; }
  const match = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*$/.exec(value);
  const start = match ? parseTime(match[1]) : null;
  let end = match ? parseTime(match[2]) : null;
  if (end === 0) end = DAY_MINUTES;
  const range = { start, end };
  if (start === null || end === null || !timeRangeSchema.safeParse(range).success) { r.error(path, "Plage invalide : \"HH:MM-HH:MM\" (début 00:00–23:59, fin 00:01–24:00 ; une fin antérieure au début se termine le lendemain)."); return undefined; }
  return range as TimeRange;
}
function readRanges(r: Reader, value: unknown, path: string): TimeRange[] | undefined {
  if (value === null) return [];
  const list = r.list(value, path, MAX_RANGES, "plages par jour");
  if (!list) return undefined;
  const ranges: TimeRange[] = [];
  let failed = false;
  for (const [index, item] of list.entries()) { const range = readRange(r, item, at(path, index)); if (range) ranges.push(range); else failed = true; }
  return failed ? undefined : ranges;
}
function readCalendar(r: Reader, value: unknown, path: string, fallback: Calendar): Calendar | undefined {
  const section = r.section(value, path, ["week", "exceptions"]);
  if (!section) return value === undefined || value === null ? fallback : undefined;
  const calendar: Calendar = { week: fallback.week.map(ranges => ranges.map(range => ({ ...range }))), exceptions: {} };
  let failed = false;
  const week = own(section, "week");
  if (Array.isArray(week)) {
    if (week.length !== 7) { r.error(at(path, "week"), "La semaine compte 7 jours (lundi en premier)."); return undefined; }
    for (const [index, day] of week.entries()) { const ranges = readRanges(r, day, `${at(path, "week")}[${index}]`); if (ranges) calendar.week[index] = ranges; else failed = true; }
  } else if (isObj(week)) {
    calendar.week = DAYS.map(() => []);
    for (const key of Object.keys(week)) {
      const index = DAYS.indexOf(key.toLowerCase() as (typeof DAYS)[number]);
      if (index < 0) { r.warn(`${at(path, "week")}.${key}`, `Jour inconnu « ${key} » : ignoré (lundi … dimanche).`); continue; }
      const ranges = readRanges(r, week[key], `${at(path, "week")}.${key}`);
      if (ranges) calendar.week[index] = ranges; else failed = true;
    }
  } else if (week !== undefined && week !== null) { r.error(at(path, "week"), "Semaine attendue : jours (lundi: [...]) ou liste de 7 jours."); return undefined; }
  const exceptions = own(section, "exceptions");
  if (exceptions !== undefined && exceptions !== null) {
    if (!isObj(exceptions)) { r.error(at(path, "exceptions"), "Exceptions attendues : \"AAAA-MM-JJ\": [plages]."); return undefined; }
    const dates = Object.keys(exceptions);
    if (dates.length > MAX_EXCEPTIONS) { r.error(at(path, "exceptions"), `${MAX_EXCEPTIONS} exceptions au plus.`); return undefined; }
    for (const date of dates) {
      const datePath = `${at(path, "exceptions")}.${date}`;
      if (!isoDateSchema.safeParse(date).success) { r.error(datePath, "Date invalide (AAAA-MM-JJ)."); failed = true; continue; }
      const ranges = readRanges(r, exceptions[date], datePath);
      if (ranges) calendar.exceptions[date] = ranges; else failed = true;
    }
  }
  return failed ? undefined : calendar;
}

function readSchedule(r: Reader, value: unknown): Schedule | undefined {
  const section = r.section(value, "schedule", ["timeZone", "watch", "publish", "graceMinutes", "catchUpHours", "majorEvents", "retentionDays"]);
  if (!section) return undefined;
  const timeZone = r.string(own(section, "timeZone"), "schedule.timeZone", scheduleSchema.shape.timeZone, "Fuseau horaire IANA inconnu (ex. Europe/Paris).");
  if (timeZone === undefined && own(section, "timeZone") !== undefined) return undefined;
  const base = defaultSchedule(timeZone ?? "Europe/Paris");
  if (timeZone === undefined) r.warn("schedule.timeZone", `Fuseau horaire absent : ${base.timeZone} utilisé.`);
  const watch = readCalendar(r, own(section, "watch"), "schedule.watch", base.watch);
  const publish = readCalendar(r, own(section, "publish"), "schedule.publish", base.publish);
  const graceMinutes = r.integer(own(section, "graceMinutes"), "schedule.graceMinutes", 0, 240);
  const catchUpHours = r.integer(own(section, "catchUpHours"), "schedule.catchUpHours", 0, 168);
  let majorEvents: boolean | undefined;
  const major = own(section, "majorEvents");
  if (isObj(major)) majorEvents = r.boolean(own(r.section(major, "schedule.majorEvents", ["enabled"])!, "enabled"), "schedule.majorEvents.enabled");
  else majorEvents = r.boolean(major, "schedule.majorEvents");
  const retention = own(section, "retentionDays");
  const retentionDays = retention === null ? null : r.integer(retention, "schedule.retentionDays", 1, 365);
  const failed = [watch, publish].includes(undefined) || [["graceMinutes", graceMinutes], ["catchUpHours", catchUpHours], ["majorEvents", majorEvents], ["retentionDays", retentionDays]].some(([key, parsed]) => parsed === undefined && own(section, key as string) !== undefined && own(section, key as string) !== null);
  if (failed) return undefined;
  const schedule: Schedule = {
    ...base, watch: watch!, publish: publish!,
    graceMinutes: graceMinutes ?? base.graceMinutes, catchUpHours: catchUpHours ?? base.catchUpHours,
    majorEvents: { enabled: majorEvents ?? base.majorEvents.enabled }, retentionDays: retentionDays === undefined ? base.retentionDays : retentionDays,
  };
  if (!scheduleSchema.safeParse(schedule).success) { r.error("schedule", "Calendriers invalides."); return undefined; }
  return schedule;
}

function readAppearance(r: Reader, value: unknown): BloubConfig | undefined {
  const section = r.section(value, "appearance", ["shape", "expression", "color"]);
  if (!section) return undefined;
  const config: BloubConfig = { ...DEFAULT_BLOUB_CONFIG };
  let given = false;
  for (const key of ["shape", "expression", "color"] as const) {
    const id = r.string(own(section, key), at("appearance", key), bloubConfigSchema.shape[key], `Identifiant inconnu du catalogue Bloub (${key}).`);
    if (id !== undefined) { (config as Record<string, unknown>)[key] = id; given = true; }
    else if (own(section, key) !== undefined && own(section, key) !== null) return undefined;
  }
  return given ? config : undefined;
}

/** Parses an untrusted YAML configuration into a draft patch; never throws. */
export function parseAgentYaml(text: string, { catalog, presets }: { catalog: Topic[]; presets: Preset[] }): YamlImport {
  const fatal = (path: string, message: string): YamlImport => ({ ok: false, issues: [{ level: "error", path, message }] });
  if (typeof text !== "string" || !text.trim()) return fatal("", "Fichier vide.");
  if (new TextEncoder().encode(text).length > MAX_YAML_BYTES) return fatal("", `Fichier trop volumineux (${MAX_YAML_BYTES / 1000} ko au plus).`);
  let data: unknown;
  try {
    const doc = parseDocument(text, { schema: "core", uniqueKeys: true, prettyErrors: true, merge: false, version: "1.2" });
    if (doc.errors.length) {
      const error = doc.errors[0];
      const line = error.linePos?.[0];
      return fatal("", `${error.code === "DUPLICATE_KEY" ? "Clé en double" : error.code === "MULTIPLE_DOCS" ? "Un seul document YAML est accepté" : "Syntaxe YAML invalide"}${line ? ` (ligne ${line.line}, colonne ${line.col})` : ""}.`);
    }
    let tagged = false;
    visit(doc, { Node(_, node) { if ((node as { tag?: string }).tag) { tagged = true; return visit.BREAK; } } });
    if (tagged || doc.warnings.length) return fatal("", "Les étiquettes YAML personnalisées (!tag, !!js/…) sont interdites.");
    data = doc.toJS({ maxAliasCount: 20 });
  } catch {
    return fatal("", "Fichier refusé : trop d’alias ou structure invalide.");
  }
  if (!isObj(data)) return fatal("", "Le fichier doit contenir une configuration (clés: valeurs).");
  if (depth(data) > MAX_DEPTH) return fatal("", "Structure trop profonde.");
  const version = own(data, "xiagent");
  if (version === undefined || version === null) return fatal("xiagent", `Version du format absente : ajoutez « xiagent: ${AGENT_YAML_VERSION} » en tête du fichier.`);
  if (typeof version !== "number" || !Number.isInteger(version)) return fatal("xiagent", "Version du format invalide : entier attendu.");
  if (version !== AGENT_YAML_VERSION) return fatal("xiagent", `Version incompatible : xiagent ${version} (seule la version ${AGENT_YAML_VERSION} est prise en charge).`);

  const r = new Reader();
  r.section(data, "", ["xiagent", "kind", "identity", "topics", "editorial", "style", "sources", "schedule", "publication", "appearance"]);
  const kind = own(data, "kind") ?? "agent";
  if (kind !== "agent" && kind !== "topic") return fatal("kind", "Type attendu : agent ou topic.");
  const target: Target = kind;
  const patch: DraftPatch = {};
  const topics = readTopics(r, own(data, "topics"), catalog, target);
  if (topics) patch.topics = topics;
  if (target === "topic") {
    for (const key of ["identity", "editorial", "style", "sources", "schedule", "publication", "appearance"]) if (own(data, key) !== undefined) r.warn(key, "Ignoré pour kind: topic.");
    return { ok: true, target, patch, issues: r.issues };
  }

  const identity = r.section(own(data, "identity"), "identity", ["name", "handle", "description"]);
  if (identity) {
    const name = r.string(own(identity, "name"), "identity.name", shape.name, "Nom requis (160 caractères au plus).");
    if (name !== undefined) patch.name = name.trim();
    const handle = r.string(own(identity, "handle"), "identity.handle", shape.handle, "Handle invalide : minuscules, chiffres, tirets et points.");
    if (handle !== undefined) patch.handle = handle.trim().replace(/^@/, "");
    const about = r.string(own(identity, "description"), "identity.description", shape.description, "Description trop longue (4 000 caractères au plus).");
    if (about !== undefined) patch.about = about.trim();
  }
  const editorial = r.section(own(data, "editorial"), "editorial", ["perimeter", "charter"]);
  if (editorial) {
    for (const key of ["perimeter", "charter"] as const) {
      const text = r.string(own(editorial, key), at("editorial", key), profileSchema.shape[key], "Texte trop long (4 000 caractères au plus).");
      if (text !== undefined) patch[key] = text.trim();
    }
  }
  readStyle(r, own(data, "style"), presets, patch);
  const sources = readSources(r, own(data, "sources"));
  if (sources) patch.sources = sources;
  const schedule = readSchedule(r, own(data, "schedule"));
  if (schedule) patch.schedule = schedule;
  const publication = r.section(own(data, "publication"), "publication", ["autoPublish"]);
  if (publication) { const value = r.boolean(own(publication, "autoPublish"), "publication.autoPublish"); if (value !== undefined) patch.autoPublish = value; }
  const bloub = readAppearance(r, own(data, "appearance"));
  if (bloub) patch.bloub = bloub;
  return { ok: true, target, patch, issues: r.issues };
}

// ---------------------------------------------------------------- export

const calendarToYaml = (calendar: Calendar) => ({
  week: Object.fromEntries(DAYS.map((day, index) => [day, calendar.week[index].map(range => `${formatTime(range.start)}-${formatTime(range.end)}`)])),
  exceptions: Object.fromEntries(Object.keys(calendar.exceptions).sort().map(date => [date, calendar.exceptions[date].map(range => `${formatTime(range.start)}-${formatTime(range.end)}`)])),
});

/** Portable YAML of a draft: stable key order, topics by tag, no internal identifier. */
export function draftToYaml(draft: AgentDraft, catalog: Topic[]): string {
  const tagOf = (id: string | null) => id ? catalog.find(topic => topic.id === id)?.tag : undefined;
  // Every reference is exported in its place, or the export fails: a missing topic is never dropped (a secondary would become primary).
  const topic = (pick: TopicPick, index: number) => {
    const label = index === 0 ? "Le topic principal" : `Le topic secondaire ${index}`;
    if (pick.type === "existing" || pick.type === "unresolved") {
      const tag = pick.type === "existing" ? tagOf(pick.id) : pick.tag ?? (pick.id ? tagOf(pick.id) : undefined);
      if (!tag) throw new TopicError(`${label} n’existe plus dans le catalogue et son étiquette est inconnue : export impossible sans modifier le périmètre. Remplacez-le ou retirez-le d’abord.`, 409);
      return tag;
    }
    const parent = tagOf(pick.draft.parentId);
    const related = pick.draft.relatedIds.map(tagOf).filter((tag): tag is string => !!tag);
    return { tag: pick.draft.tag, name: pick.draft.name, scope: pick.draft.scope, ...(pick.draft.description ? { description: pick.draft.description } : {}), ...(parent ? { parent } : {}), ...(related.length ? { related } : {}) };
  };
  const [primary, ...secondary] = draft.topics.map(topic);
  const data: Obj = { xiagent: AGENT_YAML_VERSION, kind: draft.target };
  if (draft.target === "topic") {
    if (primary) data.topics = { primary };
  } else {
    data.identity = { name: draft.name, handle: draft.handle, description: draft.about };
    if (primary) data.topics = { primary, secondary };
    data.editorial = { perimeter: draft.perimeter, charter: draft.charter };
    const [presetId, version] = draft.presetKey.split(":");
    data.style = {
      ...(presetId ? { preset: `${presetId}@${version}` } : {}),
      ...(draft.settings ? { tone: draft.settings.tone, audience: draft.settings.audience, structure: draft.settings.structure, depth: draft.settings.depth } : {}),
      ...(draft.modelRef.trim() ? { model: draft.modelRef.trim() } : {}),
    };
    data.sources = draft.sources.map(source => ({ url: source.url, type: source.type, rationale: source.rationale, status: source.status }));
    const schedule = draft.schedule;
    data.schedule = {
      timeZone: schedule.timeZone, watch: calendarToYaml(schedule.watch), publish: calendarToYaml(schedule.publish),
      graceMinutes: schedule.graceMinutes, catchUpHours: schedule.catchUpHours, majorEvents: schedule.majorEvents.enabled, retentionDays: schedule.retentionDays,
    };
    data.publication = { autoPublish: draft.autoPublish };
    data.appearance = { shape: draft.bloub.shape, expression: draft.bloub.expression, color: draft.bloub.color };
  }
  const doc = new Document(data, { version: "1.2" });
  doc.commentBefore = HEADER;
  // Short lists of scalars (time ranges, secondary tags) stay on one line.
  // Dates are quoted: YAML 1.1 tools would otherwise read them as timestamps.
  visit(doc, {
    Seq(_, node) { if (node.items.every(item => isScalar(item))) node.flow = true; },
    Pair(_, pair) { if (isScalar(pair.key) && typeof pair.key.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(pair.key.value)) pair.key.type = "QUOTE_DOUBLE"; },
  });
  return doc.toString({ lineWidth: 0 });
}
