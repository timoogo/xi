import type { AccountStore } from "../accounts/store";
import type { TopicStore } from "../topics/store";
import type { SourceStore } from "../watch/sources";
import type { AgentDraft, SourceRow, TopicPick } from "./draft";
import { defaultSchedule, scheduleSchema } from "./schedule";

/**
 * Draft of an existing ΞAgent, for its YAML export (`draftToYaml`). Owner-only: another owner's
 * agent is "introuvable" (TopicError 404). Only the configuration is read: no run history,
 * publications, revisions or deployment records. Duplicating an agent is export + import: the
 * copy is a new deployment (new handle required), whose sources must be re-approved.
 */
export async function exportAgentDraft({ owner, agentId, accounts, topics, sources }: { owner: string; agentId: string; accounts: AccountStore; topics: TopicStore; sources: SourceStore }): Promise<AgentDraft> {
  const account = await accounts.getOwned(owner, agentId);
  const [catalog, profile, schedule, watch, avatar, presets, owned, llm] = await Promise.all([
    topics.list(), accounts.profile(owner, agentId), accounts.schedule(owner, agentId), accounts.watchPolicy(owner, agentId),
    accounts.avatar(owner, agentId), accounts.listPresets(owner), sources.list(owner), accounts.llm(owner, agentId),
  ]);
  const editorial = account.editorial;
  // Missing topics stay in place as unresolved references: draftToYaml then refuses a misleading export.
  const topicIds = editorial ? [editorial.primaryTopicId, ...editorial.secondaryTopicIds] : [];
  const covered = new Set(topicIds);
  const preset = editorial ? presets.find(item => item.id === editorial.presetId && item.version === editorial.presetVersion) : presets[0];
  const rows: SourceRow[] = owned.sources
    // A shared file never carries credentials: URLs with secret-looking query parameters are left out.
    .filter(source => (source.status === "approved" || source.status === "rejected") && source.topicIds.some(id => covered.has(id)) && !/[?&][^=]*(token|key|secret|sig|auth|pass|session)[^=]*=/i.test(source.url))
    .slice(0, 50)
    .map(source => ({
      url: source.url, domain: new URL(source.url).hostname, type: source.kind === "json" ? "API JSON" : "flux", rationale: source.publisher.slice(0, 500),
      origin: "user", status: source.status === "approved" ? "approved" : "excluded",
    }));
  // One row per domain, as in the creation dialog.
  const sourcesByDomain = rows.filter((row, index) => rows.findIndex(other => other.domain === row.domain) === index);
  return {
    target: "agent", description: "",
    name: account.name, handle: account.handle, about: account.description,
    topics: topicIds.map((id): TopicPick => catalog.some(topic => topic.id === id) ? { type: "existing", id } : { type: "unresolved", tag: null, id }),
    perimeter: profile?.perimeter ?? "", charter: profile?.charter ?? "",
    presetKey: editorial ? `${editorial.presetId}:${editorial.presetVersion}` : preset ? `${preset.id}:${preset.version}` : "",
    settings: editorial?.settings ?? preset?.settings ?? null,
    // Instance kept by id here; draftToYaml exports its portable key, never the id or URL.
    llm: { instanceId: llm.config.instanceId, unresolvedKey: null, model: llm.config.model ?? (llm.legacy ? editorial?.modelRef ?? "" : ""), options: llm.config.options },
    autoPublish: watch.policy.autoPublish,
    sources: sourcesByDomain,
    schedule: schedule.explicit && schedule.valid ? scheduleSchema.strip().parse(schedule) : defaultSchedule(schedule.timeZone),
    bloub: avatar.config,
    provenance: {}, model: null,
  };
}
