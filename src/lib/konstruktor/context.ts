import type { AccountStore } from "../accounts/store";
import { BUILTIN_PRESETS, type Settings } from "../accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../bloub/config";
import type { BloubConfig } from "../bloub/types";
import type { LLMStore } from "../llm/store";
import { INHERIT_LLM, type AgentLLMConfig } from "../llm/types";
import type { TopicStore } from "../topics/store";
import { isPersonal, TopicError, type Topic } from "../topics/types";
import { describeRanges, WEEKDAYS } from "../xiagents/calendar";
import { DEFAULT_LIMITS, type PublicationLimits } from "../xiagents/draft";
import { defaultSchedule, scheduleSchema, type Schedule } from "../xiagents/schedule";
import type { KonstruktorTarget } from "./types";

/**
 * What Konstruktor may read for a conversation, on behalf of its user only: the shared catalogue,
 * the user's own personal topics, the user's own local model instances, and the target if the
 * user may see it (their own ΞAgent, a visible topic). Anything else is unknown (404). Texts are
 * returned as data for the prompt; `base` is the current configuration proposals are built on.
 */
export type ModelChoices = { instances: { id: string; name: string; models: string[] }[]; defaultInstanceId: string | null };
export type ContextServices = { accounts: AccountStore; topics: TopicStore; models?: (owner: string) => ModelChoices };
export type AgentBase = { settings: Settings; schedule: Schedule; limits: PublicationLimits; autoPublish: boolean; llm: AgentLLMConfig; bloub: BloubConfig };
export type TargetContext = { label: string; target: Record<string, unknown> | null; catalog: Topic[]; focus: string[]; base: AgentBase | null; models: ModelChoices };
export const MAX_CATALOG = 60;
const DEFAULT_TIME_ZONE = "Europe/Paris";

/** The owner's enabled local instances and their known models (discovered list and default model). */
export function modelChoices(store: Pick<LLMStore, "list" | "settings">, owner: string): ModelChoices {
  const instances = store.list(owner).filter(instance => instance.enabled).map(instance => ({
    id: instance.id, name: instance.name,
    models: [...new Set([...(instance.defaultModel ? [instance.defaultModel] : []), ...(instance.models ?? []).map(model => model.name)])].slice(0, 30),
  }));
  return { instances, defaultInstanceId: store.settings(owner).defaultInstanceId };
}

export const describeSchedule = (schedule: Schedule) => ({
  fuseau: schedule.timeZone,
  veille: schedule.watch.week.map((ranges, day) => `${WEEKDAYS[day]} ${describeRanges(ranges)}`).join(" ; "),
  publication: schedule.publish.week.map((ranges, day) => `${WEEKDAYS[day]} ${describeRanges(ranges)}`).join(" ; "),
  toleranceMinutes: schedule.graceMinutes, evenementsMajeurs: schedule.majorEvents.enabled,
});

export async function loadContext({ accounts, topics, models }: ContextServices, owner: string, target: KonstruktorTarget): Promise<TargetContext> {
  const { shared, personal } = await topics.visible(owner);
  const catalog: Topic[] = [...shared, ...personal];
  const tagOf = (id: string) => catalog.find(topic => topic.id === id)?.tag ?? null;
  const choices = models?.(owner) ?? { instances: [], defaultInstanceId: null };
  if (target.type === "topic") {
    const topic = catalog.find(item => item.id === target.id);
    if (!topic) throw new TopicError("Topic introuvable.", 404);
    const children = catalog.filter(item => item.parentId === topic.id);
    return {
      label: `Topic #${topic.tag}`, catalog, base: null, models: choices, focus: [topic.id, ...(topic.parentId ? [topic.parentId] : []), ...children.map(child => child.id)],
      target: { type: "topic", tag: topic.tag, name: topic.name, scope: topic.scope, description: topic.description, personal: isPersonal(topic), modifiable: topic.createdBy === owner, parent: topic.parentId ? tagOf(topic.parentId) : null, children: children.map(child => child.tag) },
    };
  }
  if (target.type === "agent") {
    const account = await accounts.getOwned(owner, target.id);
    const [profile, schedule, watch, llm, avatar, presets] = await Promise.all([
      accounts.profile(owner, account.id), accounts.schedule(owner, account.id), accounts.watchPolicy(owner, account.id), accounts.llm(owner, account.id), accounts.avatar(owner, account.id), accounts.listPresets(owner),
    ]);
    const topicIds = account.editorial ? [account.editorial.primaryTopicId, ...account.editorial.secondaryTopicIds] : [];
    const base: AgentBase = {
      settings: account.editorial?.settings ?? presets[0]?.settings ?? BUILTIN_PRESETS[0].settings,
      schedule: schedule.explicit && schedule.valid ? scheduleSchema.strip().parse(schedule) : defaultSchedule(schedule.timeZone),
      limits: { maxPerDay: watch.policy.maxPerDay, minIntervalMinutes: watch.policy.minIntervalMinutes }, autoPublish: watch.policy.autoPublish,
      llm: llm.config, bloub: avatar.config,
    };
    const instance = choices.instances.find(item => item.id === llm.config.instanceId);
    return {
      label: `ΞAgent @${account.handle}`, catalog, focus: topicIds, base, models: choices,
      target: {
        type: "agent", name: account.name, handle: account.handle, description: account.description,
        topics: topicIds.map(id => tagOf(id) ?? "topic indisponible"), active: account.editorial?.active ?? false,
        style: base.settings, perimeter: profile?.perimeter ?? "", charter: profile?.charter ?? "",
        calendriers: describeSchedule(base.schedule),
        publication: { autonome: base.autoPublish, maxParJour: base.limits.maxPerDay, intervalleMinutes: base.limits.minIntervalMinutes, visibilite: watch.policy.visibility },
        modele: { instance: instance?.name ?? "configuration globale", modele: llm.config.model ?? "modèle par défaut" },
        avatar: { shape: avatar.config.shape, expression: avatar.config.expression, color: avatar.config.color },
      },
    };
  }
  const presets = target.type === "new-agent" ? await accounts.listPresets(owner) : [];
  const base: AgentBase | null = target.type === "new-agent" ? {
    settings: presets[0]?.settings ?? BUILTIN_PRESETS[0].settings, schedule: defaultSchedule(DEFAULT_TIME_ZONE), limits: DEFAULT_LIMITS, autoPublish: false, llm: INHERIT_LLM, bloub: DEFAULT_BLOUB_CONFIG,
  } : null;
  return { label: target.type === "new-agent" ? "Nouveau ΞAgent" : "Nouveau topic", target: null, catalog, focus: [], base, models: choices };
}

/** At most MAX_CATALOG topics for the prompt, the target's own first. */
export const shownCatalog = (context: TargetContext) =>
  [...new Map([...context.focus.flatMap(id => context.catalog.filter(topic => topic.id === id)), ...context.catalog].map(topic => [topic.id, topic])).values()].slice(0, MAX_CATALOG);
