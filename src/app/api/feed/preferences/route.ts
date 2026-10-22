import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { z } from "zod";
import { getViewer } from "@/lib/publications/server";
import { PREFERENCES } from "@/lib/publications/social";
import { publicationResponse, privateJson } from "@/lib/publications/http";
import { readJson } from "@/lib/graph/server";
const input = z.object({ authorId: z.string(), following: z.boolean().optional(), preference: z.enum(PREFERENCES).nullable().optional() });
export async function GET() {
  return publicationResponse((store, currentViewer) => store.social(currentViewer));
}
export async function PUT(request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(getAuth().options.baseURL!).origin) return NextResponse.json({ error: "Origine refusée" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Authentification requise" }, 401);
  const parsed = input.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "Préférence invalide" }, { status: 400 });
  return publicationResponse((store, currentViewer) => store.setSocial(currentViewer, parsed.data.authorId, parsed.data));
}
