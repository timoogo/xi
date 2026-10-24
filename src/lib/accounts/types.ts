import { z } from "zod";
import { GENERATOR_SLUG } from "../graph/types";
import type { Step, RunEvent } from "../topics/types";

export const CHARTER = "Transparence, traçabilité des sources, distinction entre faits et interprétations, respect du scope du topic principal.";
export const settingsSchema = z.object({
  tone: z.string().trim().min(1).max(300), structure: z.string().trim().min(1).max(1000),
  depth: z.enum(["court", "standard", "approfondi"]), audience: z.string().trim().min(1).max(300),
}).strict();
export const accountDraftSchema = z.object({
  handle: z.string().trim().transform(value => value.replace(/^@/, "")).pipe(z.string().max(180).regex(GENERATOR_SLUG)),
  name: z.string().trim().min(1).max(160), description: z.string().trim().max(4000),
  primaryTopicId: z.uuid(), secondaryTopicIds: z.array(z.uuid()).max(30),
  presetId: z.string().min(1).max(100), presetVersion: z.number().int().positive(),
  settings: settingsSchema, active: z.boolean(),
  modelRef: z.string().trim().min(1).max(200).nullable(), validationMode: z.literal("human"),
}).strict();
export const editorialSchema = accountDraftSchema.omit({ handle: true, name: true, description: true }).extend({
  updatedAt: z.iso.datetime(), updatedBy: z.string().min(1), revision: z.uuid(),
});
/** Autonomous watch policy: top-level `watch` key of the generator file, outside `editorial`
 * (which the configuration form rewrites). No minimum quota; disabled until explicitly enabled. */
export const watchPolicySchema = z.object({
  enabled: z.boolean(), paused: z.boolean(),
  maxPerDay: z.number().int().min(1).max(24), minIntervalMinutes: z.number().int().min(15).max(10_080),
  /** Separate rolling 24 h ceiling for fixture publications, which never consume the real quota. */
  testMaxPerDay: z.number().int().min(1).max(100).default(10),
  /** Importance from which a verified candidate may become an immediate alert, and the night window minimum. */
  alertThreshold: z.number().min(0.5).max(1).default(0.85),
  nightThreshold: z.number().min(0).max(0.95).default(0.45),
  /** Autonomous publication of validated drafts; also requires XI_WATCH_AUTOPUBLISH on the worker. */
  autoPublish: z.boolean().default(false),
  /** Public also requires a server-recorded confirmation and XI_WATCH_AUTOPUBLISH_PUBLIC. */
  visibility: z.enum(["private", "public"]).default("private"),
  /** Separate ceiling for immediate alerts over a rolling 24 h (0 disables alerts). */
  maxImmediatePerDay: z.number().int().min(0).max(5).default(1),
}).strict();
export const storedWatchPolicySchema = watchPolicySchema.extend({
  revision: z.uuid(), updatedAt: z.iso.datetime(), updatedBy: z.string().min(1),
  publicConfirmedAt: z.iso.datetime().nullable().default(null), publicConfirmedBy: z.string().min(1).nullable().default(null),
});
export type WatchPolicy = z.infer<typeof watchPolicySchema>;
export const DEFAULT_WATCH_POLICY: WatchPolicy = { enabled: false, paused: false, maxPerDay: 3, minIntervalMinutes: 240, testMaxPerDay: 10, alertThreshold: 0.85, nightThreshold: 0.45, autoPublish: false, visibility: "private", maxImmediatePerDay: 1 };
/** `valid: false` means an unreadable `watch` key: the agent stays disabled until its owner rewrites it. */
export type WatchSettings = { policy: WatchPolicy; revision: string | null; valid: boolean; publicConfirmedAt: string | null };
export type WatchAgent = { id: string; handle: string; owner: string; active: boolean; primaryTopicId: string; secondaryTopicIds: string[]; modelRef: string | null; watch: WatchSettings };
export const presetSchema =z.object({ id: z.string().min(1).max(100), version: z.number().int().positive(), name: z.string().trim().min(1).max(160), settings: settingsSchema, owner: z.string().nullable(), createdAt: z.iso.datetime() });
export type Settings = z.infer<typeof settingsSchema>;
export type AccountDraft = z.infer<typeof accountDraftSchema>;
export type Editorial = z.infer<typeof editorialSchema>;
export type Preset = z.infer<typeof presetSchema>;
export type Account = { id: string; handle: string; name: string; description: string; owner: string; createdAt: string | null; editorial: Editorial | null };
export const ACCOUNT_STEPS = ["Sélection du topic", "Chargement du scope", "Vérification des handles", "Proposition déterministe", "Sélection et personnalisation du preset", "Confirmation humaine", "Écriture Markdown", "Indexation SQLite", "Vérification de l’intégrité"];
export type AccountRun = { id: string; owner: string; accountId: string; topicId: string; state: "running" | "waiting" | "failed" | "completed"; draft: AccountDraft | null; confirmed: boolean; steps: Step[]; events: RunEvent[] };
const styles: [string, string, string, Settings["depth"]][] = [
  ["analyste", "Analyste", "Factuel, structuré", "approfondi"],
  ["pedagogue", "Pédagogue", "Accessible, explicatif, progressif", "standard"],
  ["journaliste", "Journaliste", "Synthétique, direct, informatif", "court"],
  ["historien", "Historien", "Contextualisation et perspective chronologique", "approfondi"],
];
export const BUILTIN_PRESETS: Preset[] = styles.map(([id, name, tone, depth]) => ({ id, version: 1, name, owner: null, createdAt: "2026-01-01T00:00:00.000Z", settings: { tone, depth, audience: "Grand public", structure: id === "historien" ? "Contexte, chronologie, conséquences" : id === "pedagogue" ? "Notions, explication progressive, exemples" : id === "journaliste" ? "Essentiel, faits, sources" : "Faits, analyse, limites, sources" } }));
