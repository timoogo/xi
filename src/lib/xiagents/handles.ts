import { GENERATOR_SLUG } from "../graph/types";
import { TopicError } from "../topics/types";

/**
 * Bounded, deterministic search for a free handle: `base`, then `stem-2`, `stem-3`… where the stem
 * is `base` without a trailing `-<digits>` suffix, truncated so that every candidate stays a valid
 * handle (GENERATOR_SLUG, at most 180 characters). Pure and client-safe; availability is injected.
 * This is only a suggestion: the server keeps enforcing uniqueness when the agent is written.
 */
export const MAX_HANDLE_ATTEMPTS = 20;
const MAX_HANDLE_LENGTH = 180;

export class HandleUnavailableError extends TopicError {
  constructor(readonly base: string, readonly attempts: number) {
    super(`Aucun handle libre trouvé à partir de @${base} après ${attempts} essais : choisissez-en un autre.`, 409);
  }
}

const isHandle = (value: string) => value.length > 0 && value.length <= MAX_HANDLE_LENGTH && GENERATOR_SLUG.test(value);

export function handleCandidates(base: string, max = MAX_HANDLE_ATTEMPTS): string[] {
  const handle = base.trim().replace(/^@/, "");
  if (!isHandle(handle)) throw new TopicError(`Handle invalide : @${handle.slice(0, 60)} (minuscules, chiffres, tirets et points, 180 caractères au plus).`, 400);
  const count = Math.max(1, Math.floor(max));
  const room = MAX_HANDLE_LENGTH - `-${count + 1}`.length;
  const stem = (handle.replace(/-\d+$/, "") || handle).slice(0, room).replace(/[-.]+$/, "");
  const candidates = [handle];
  for (let suffix = 2; candidates.length < count; suffix++) {
    const candidate = `${stem}-${suffix}`;
    if (candidate !== handle) candidates.push(candidate);
  }
  return candidates;
}

/** Sequential: stops at the first free candidate, at most `max` availability calls. */
export async function findFreeHandle(base: string, available: (handle: string) => Promise<boolean>, max = MAX_HANDLE_ATTEMPTS): Promise<string> {
  const candidates = handleCandidates(base, max);
  for (const candidate of candidates) if (await available(candidate)) return candidate;
  throw new HandleUnavailableError(candidates[0], candidates.length);
}
