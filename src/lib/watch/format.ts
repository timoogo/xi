import { z } from "zod";

/**
 * Publication format limits (client-safe, no server import). Global per owner (Paramètres →
 * Publications, `format-store.ts`), overridable per ΞAgent (`watch.format`, absent field =
 * inherited). Lengths count the prose written by the model, in Unicode code points; the
 * `## Sources` section that Ξ appends is not counted. A text over a limit is never truncated:
 * the model is asked to rewrite it, within `correctionAttempts`, then the draft is held.
 */
const chars = z.number().int().min(50).max(5_000);
const fields = {
  maxPostChars: chars,
  maxThreadMessageChars: chars,
  minThreadMessages: z.number().int().min(2).max(10),
  maxThreadMessages: z.number().int().min(2).max(10),
  /** Guidance for the model only: never enforced, never a reason to pad. */
  targetPostMin: chars, targetPostMax: chars,
  threads: z.boolean(),
  /** Off: the autonomous circuit always writes posts; a thread can still be asked explicitly. */
  autoFormat: z.boolean(),
  /** Rewrites asked after a non-compliant answer (0 = a single attempt). */
  correctionAttempts: z.number().int().min(0).max(5),
};
export type FormatSettings = { [K in keyof typeof fields]: z.infer<(typeof fields)[K]> };
export const DEFAULT_FORMAT: FormatSettings = {
  maxPostChars: 280, maxThreadMessageChars: 280, minThreadMessages: 2, maxThreadMessages: 10,
  targetPostMin: 180, targetPostMax: 250, threads: true, autoFormat: true, correctionAttempts: 2,
};

/** Problems of a complete set of limits (after merging the agent's overrides onto the global ones). */
export function formatProblems(format: FormatSettings): string[] {
  const problems: string[] = [];
  if (format.minThreadMessages > format.maxThreadMessages) problems.push("Le minimum de messages d’un thread dépasse le maximum.");
  if (format.targetPostMin > format.targetPostMax) problems.push("La longueur cible minimale dépasse la maximale.");
  if (format.targetPostMax > format.maxPostChars) problems.push("La longueur cible dépasse la longueur maximale d’un post.");
  return problems;
}
export const formatSettingsSchema = z.object(fields).strict().superRefine((format, ctx) => {
  for (const message of formatProblems(format)) ctx.addIssue({ code: "custom", message });
});
/** Agent overrides: every field optional; consistency is checked once merged (`resolveFormat`). */
export const formatOverridesSchema = z.object(fields).partial().strict();
export type FormatOverrides = z.infer<typeof formatOverridesSchema>;

export type ResolvedFormat = { ok: true; format: FormatSettings } | { ok: false; problems: string[] };
export function resolveFormat(global: FormatSettings, overrides: FormatOverrides | null | undefined): ResolvedFormat {
  const format = { ...global, ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)) } as FormatSettings;
  const problems = formatProblems(format);
  return problems.length ? { ok: false, problems } : { ok: true, format };
}

export const charCount = (text: string) => [...text.trim()].length;

/**
 * Code checks of a draft's shape against the limits: post or thread, number of messages, length of
 * each message individually (the prose only, without the sources section).
 */
export function checkFormat(messages: string[], format: FormatSettings): string[] {
  const problems: string[] = [];
  if (messages.length > 1) {
    if (!format.threads) problems.push("Les threads sont désactivés pour ce ΞAgent : un seul message.");
    if (messages.length < format.minThreadMessages) problems.push(`Un thread contient au moins ${format.minThreadMessages} messages.`);
    if (messages.length > format.maxThreadMessages) problems.push(`Un thread contient au plus ${format.maxThreadMessages} messages.`);
  }
  const limit = messages.length > 1 ? format.maxThreadMessageChars : format.maxPostChars;
  messages.forEach((text, i) => {
    const length = charCount(text);
    if (length > limit) problems.push(`Message ${i + 1} : ${length} caractères, au-delà de la limite de ${limit} ; reformule plus court sans retirer d’attribution ni de nuance.`);
  });
  return problems;
}
