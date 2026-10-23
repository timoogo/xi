import { getAuth } from "@/lib/auth";
import { readAvatar } from "@/lib/avatars";
import { privateJson } from "@/lib/publications/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
  if (!await getAuth().api.getSession({ headers: request.headers })) return privateJson({ error: "Authentification requise." }, 401);
  try {
    const bytes = await readAvatar((await params).file);
    if (!bytes) return privateJson({ error: "Photo indisponible." }, 404);
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": "image/webp", "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store", Vary: "Cookie",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch {
    return privateJson({ error: "Photo indisponible." }, 503);
  }
}
