"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPublicationStore, getViewer } from "../publications/server";
import { PublicationError, type PublicationStore, type SaveInput, type SourceFormInput } from "../publications/store";
import type { Viewer } from "../publications/types";

// Thin Server Actions: identity comes from the session, every permission check lives in the store.
type Failure = { ok: false; message: string };

async function run<T>(task: (store: PublicationStore, viewer: Viewer) => Promise<T>): Promise<T | Failure> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, message: "Votre session a expiré. Veuillez vous reconnecter." };
  try {
    return await task(await getPublicationStore(), viewer);
  } catch (error) {
    if (error instanceof PublicationError) return { ok: false, message: error.message };
    console.error("Publication storage error", error instanceof Error ? error.name : "unknown");
    return { ok: false, message: "Le stockage des publications est indisponible. Veuillez réessayer." };
  }
}

function refreshLists() {
  // Every dashboard list and the old publication URL must reflect the change immediately.
  revalidatePath("/dashboard", "layout");
}

export async function createPublication(): Promise<Failure> {
  const result = await run((store, viewer) => store.create(viewer));
  if (typeof result !== "string") return result;
  redirect(`/dashboard/publications/${result}/edit`);
}

export async function createReply(messageRef: string): Promise<Failure> {
  const result = await run((store, viewer) => store.create(viewer, messageRef));
  if (typeof result !== "string") return result;
  redirect(`/dashboard/publications/${result}/edit`);
}

export async function savePublication(id: string, input: SaveInput) {
  return run((store, viewer) => store.save(viewer, String(id), input));
}

export async function publishPublication(id: string, revision: string) {
  const result = await run((store, viewer) => store.publish(viewer, String(id), String(revision)));
  refreshLists();
  return result;
}

export async function addPublicationSource(id: string, revision: string, source: SourceFormInput) {
  return run((store, viewer) => store.addSource(viewer, String(id), String(revision), source));
}

export async function trashPublication(id: string) {
  const result = await run(async (store, viewer) => {
    await store.trash(viewer, String(id));
    return { ok: true as const };
  });
  refreshLists();
  return result;
}

export async function restorePublication(id: string) {
  const result = await run(async (store, viewer) => ({ ok: true as const, ...await store.restore(viewer, String(id)) }));
  refreshLists();
  return result;
}
