"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "../publications/server";
import { MAX_QUERY_LENGTH, normalizeTag, searchHref, topicHref } from "../search/query";
import { searchTarget, setKnowledge, setSubscription } from "../search/server";
import { ZodError } from "zod";
import type { TopicRelationStore } from "../topics/relations";
import { getTopicRelationStore, getTopicStore } from "../topics/server";
import { TopicError } from "../topics/types";

// Thin Server Actions (POST, same-origin checked by Next.js): identity comes from the session, rules live in lib/search.

async function viewerId() {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/login");
  return viewer.id;
}

/** Submitted search: may open (and create) a personal topic for a single unknown `#tag`. */
export async function submitSearch(form: FormData): Promise<void> {
  const id = await viewerId();
  const query = String(form.get("q") ?? "").slice(0, MAX_QUERY_LENGTH).trim();
  redirect(query ? await searchTarget(id, query) : "/dashboard/explore");
}

/** Explicit "open my personal topic" from the results, including for an ambiguous tag the user chose to keep. */
export async function openPersonalTopic(form: FormData): Promise<void> {
  const id = await viewerId();
  const tag = normalizeTag(String(form.get("tag") ?? ""));
  if (!tag) redirect(searchHref(String(form.get("tag") ?? "")));
  const { topic } = await (await getTopicStore()).openPersonal(id, tag);
  redirect(topicHref(topic.tag));
}

export async function toggleTopicSubscription(form: FormData): Promise<void> {
  const id = await viewerId();
  const topic = await setSubscription(id, String(form.get("topicId") ?? ""), form.get("subscribe") === "1");
  // The discovery panel lists subscriptions on every dashboard page.
  revalidatePath("/dashboard", "layout");
  redirect(topicHref(topic.tag));
}

/** Only same-app pages of the topic graph or a topic page: never an arbitrary redirection target. */
const RETURN_PATH = /^\/dashboard\/(?:graph\?view=topics(?:&[\w%.,=-]*)?|topics\/[^/?#\s]+)$/;

/** "Mes connaissances": explicit add/remove, back to the topic page or the topic network it was done from. */
export async function toggleTopicKnowledge(form: FormData): Promise<void> {
  const id = await viewerId();
  const topic = await setKnowledge(id, String(form.get("topicId") ?? ""), form.get("known") === "1");
  const back = String(form.get("back") ?? "");
  redirect(RETURN_PATH.test(back) ? back : topicHref(topic.tag));
}

/** Errors come back to the topic page as a fixed code (never free text in the URL). */
async function onTopicPage(form: FormData, task: (viewer: string, relations: TopicRelationStore) => Promise<unknown>): Promise<void> {
  const id = await viewerId();
  const tag = normalizeTag(String(form.get("back") ?? ""));
  if (!tag) redirect("/dashboard/explore");
  let code: string | null = null;
  try { await task(id, await getTopicRelationStore()); }
  catch (error) {
    if (error instanceof TopicError) code = String(error.status);
    else if (error instanceof ZodError) code = "400";
    else throw error;
  }
  redirect(code ? `${topicHref(tag)}?relation=${code}` : topicHref(tag));
}

export async function createTopicRelation(form: FormData): Promise<void> {
  await onTopicPage(form, (viewer, relations) => relations.create(viewer, {
    source: String(form.get("source") ?? ""), target: String(form.get("target") ?? ""),
    type: String(form.get("type") ?? ""), justification: String(form.get("justification") ?? ""),
  }));
}

/** Global correction: `type` and/or `status` (accepted | excluded), with an optional reason. */
export async function correctTopicRelation(form: FormData): Promise<void> {
  const type = form.get("type"), status = form.get("status"), reason = String(form.get("reason") ?? "").trim();
  await onTopicPage(form, (viewer, relations) => relations.correct(viewer, String(form.get("relationId") ?? ""), {
    ...(type ? { type: String(type) } : {}), ...(status ? { status: String(status) } : {}), ...(reason ? { reason } : {}),
  }));
}

/** Personal exclusion (`hidden=1`) or its restoration (`hidden=0`). */
export async function hideTopicRelation(form: FormData): Promise<void> {
  await onTopicPage(form, (viewer, relations) => relations.hide(viewer, String(form.get("relationId") ?? ""), form.get("hidden") === "1"));
}
