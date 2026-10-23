import { z } from "zod";
import { readJson } from "@/lib/graph/server";
import { getAvatarPreference } from "@/lib/avatar-preferences";
import { getAuth, getAppDatabase } from "@/lib/auth";
import { AvatarError, readAvatarUpload, replaceAvatar } from "@/lib/avatars";
import { privateJson } from "@/lib/publications/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function mutate(request: Request, remove: boolean) {
  if (request.headers.get("origin") !== new URL(getAuth().options.baseURL!).origin) return privateJson({ error: "Origine refusée." }, 403);
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return privateJson({ error: "Authentification requise." }, 401);
  try {
    const bytes = remove ? null : await readAvatarUpload(request);
    const image = await replaceAvatar(session.user.id, bytes);
    return privateJson({ image, avatar: getAvatarPreference(getAppDatabase(), session.user.id) });
  } catch (error) {
    if (error instanceof AvatarError) return privateJson({ error: error.message }, error.status);
    console.error("Avatar update failed", error instanceof Error ? error.name : "unknown");
    return privateJson({ error: "Impossible de mettre à jour la photo. Réessayez." }, 503);
  }
}

export const PUT = (request: Request) => mutate(request, false);
export const DELETE = (request: Request) => mutate(request, true);


// A preview never mutates the saved avatar. Save is optimistic to protect another tab's edits.
const choice = z.object({
  seed: z.string().regex(/^[0-9a-f]{32}$/),
  mode: z.enum(["bloub", "photo"]),
  revision: z.number().int().nonnegative(),
}).strict();

export async function PATCH(request: Request) {
  if (request.headers.get("origin") !== new URL(getAuth().options.baseURL!).origin) return privateJson({ error: "Origine refusée." }, 403);
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return privateJson({ error: "Authentification requise." }, 401);
  const parsed = choice.safeParse(await readJson(request));
  if (!parsed.success) return privateJson({ error: "Choix d’avatar invalide." }, 400);
  const db = getAppDatabase();
  try {
    const result = db.transaction(() => {
      const current = getAvatarPreference(db, session.user.id);
      const user = db.prepare('SELECT image FROM "user" WHERE id = ?').get(session.user.id) as { image: string | null };
      if (current.revision !== parsed.data.revision) return { error: "Votre avatar a changé dans un autre onglet. Rechargez la page.", status: 409 };
      if (parsed.data.mode === "photo" && !user.image) return { error: "Importez d’abord une photo.", status: 400 };
      db.prepare("UPDATE user_avatar SET seed = ?, mode = ?, revision = revision + 1 WHERE user_id = ?")
        .run(parsed.data.seed, parsed.data.mode, session.user.id);
      return { image: user.image, avatar: getAvatarPreference(db, session.user.id), status: 200 };
    }).immediate();
    return privateJson(result, result.status);
  } catch (error) {
    if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return privateJson({ error: "Cette variante existe déjà. Régénérez votre Bloub." }, 409);
    console.error("Avatar choice failed", error instanceof Error ? error.name : "unknown");
    return privateJson({ error: "Impossible d’enregistrer l’avatar. Réessayez." }, 503);
  }
}
