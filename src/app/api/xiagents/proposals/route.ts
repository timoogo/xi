import { z } from "zod";
import { accountResponse, body } from "@/lib/accounts/http";
import { getTopicStore } from "@/lib/topics/server";
import { getLLMRuntime } from "@/lib/llm/server";
import { InferenceConfigError, InferenceOutputError, InferenceUnavailableError } from "@/lib/watch/inference";
import { lexicalMatches, proposeAgent } from "@/lib/xiagents/proposal";
import { findFreeHandle, HandleUnavailableError } from "@/lib/xiagents/handles";
import { proposalToPatch, suggestDraft } from "@/lib/xiagents/suggest";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Proposal of a ΞAgent from a few words or a free description.
 * - `mode: "rules"`: deterministic suggestion (local concept catalog + existing topics), no model,
 *   always available; the handle is reserved free here.
 * - `mode: "ai"` (default): local model only, the owner's global configuration (default instance and
 *   model, else the operator's XI_INFERENCE_URL server). When it is not configured or fails, the answer says so
 *   (`ok: false`) with the lexical matches of existing topics, and the client continues with the
 *   rule-based draft or manually: no proposal is ever invented. When ok, `patch` is the draft patch.
 */
const requestSchema = z.object({
  description: z.string().trim().min(2, "Décrivez le sujet en quelques mots.").max(4_000),
  mode: z.enum(["rules", "ai"]).default("ai"),
}).strict();

export async function POST(request: Request) {
  return accountResponse(request, async (accounts, owner) => {
    const { description, mode } = requestSchema.parse(await body(request, 16_384));
    const catalog = await (await getTopicStore()).list();
    const presets = await accounts.listPresets(owner);
    if (mode === "rules") {
      const suggestion = suggestDraft({ text: description, catalog, presets });
      if (suggestion.patch.handle) {
        // Exhaustion throws HandleUnavailableError, a TopicError: accountResponse answers 409 with its message.
        suggestion.patch.handle = await findFreeHandle(suggestion.patch.handle, handle => accounts.handleAvailable(handle));
      }
      return { ok: true, mode: "rules", suggestion };
    }
    const matches = lexicalMatches(description, catalog);
    let binding;
    try { binding = getLLMRuntime().bind(owner, null); }
    catch (error) { if (error instanceof InferenceConfigError) return { ok: false, unavailable: true, reason: error.message, matches }; throw error; }
    if (!binding.ok) return { ok: false, unavailable: true, reason: `${binding.message} Configurez une instance dans Paramètres → Intelligence artificielle.`, matches };
    try {
      const proposal = await proposeAgent({ inference: binding.inference, model: binding.resolved.model, description, catalog, handleAvailable: handle => accounts.handleAvailable(handle) });
      return { ok: true, proposal, matches, patch: proposalToPatch(proposal, presets) };
    } catch (error) {
      if (error instanceof InferenceUnavailableError || error instanceof InferenceConfigError) return { ok: false, unavailable: true, reason: error.message, matches };
      if (error instanceof HandleUnavailableError) return { ok: false, unavailable: false, reason: error.message, matches };
      if (error instanceof InferenceOutputError) return { ok: false, unavailable: false, reason: "Le modèle local a répondu dans un format inutilisable. Réessayez ou continuez manuellement.", matches };
      if (error instanceof Error && error.message.startsWith("Proposition sans")) return { ok: false, unavailable: false, reason: "La proposition du modèle était incomplète. Réessayez ou continuez manuellement.", matches };
      throw error;
    }
  });
}
