import { parseMessageRef } from "@/lib/graph/engine";
import { graphResponse } from "@/lib/graph/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parsed = parseMessageRef(new URL(request.url).searchParams.get("ref"));
  return graphResponse(parsed, (service, viewer, { ref }) => service.preview(viewer, ref));
}
