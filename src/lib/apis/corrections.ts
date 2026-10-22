"use server";

import { redirect } from "next/navigation";
import { getPublicationStore, getViewer } from "../publications/server";
import { PublicationError } from "../publications/store";

/** A correction starts a dated draft; publishing remains an explicit author action. */
export async function createCorrection(id: string): Promise<{ ok: false; message: string }> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, message: "Votre session a expiré. Veuillez vous reconnecter." };
  let correctionId: string;
  try {
    correctionId = await (await getPublicationStore()).createCorrection(viewer, String(id));
  } catch (error) {
    if (error instanceof PublicationError) return { ok: false, message: error.message };
    console.error("Correction storage error", error instanceof Error ? error.name : "unknown");
    return { ok: false, message: "Impossible de créer la correction. Veuillez réessayer." };
  }
  redirect(`/dashboard/publications/${correctionId}/edit`);
}
