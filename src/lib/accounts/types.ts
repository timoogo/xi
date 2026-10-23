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
export const presetSchema = z.object({ id: z.string().min(1).max(100), version: z.number().int().positive(), name: z.string().trim().min(1).max(160), settings: settingsSchema, owner: z.string().nullable(), createdAt: z.iso.datetime() });
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
