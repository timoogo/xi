import { parseViewRequest } from "@/lib/graph/engine";
import { graphResponse, readJson } from "@/lib/graph/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return graphResponse(parseViewRequest(await readJson(request)), (service, viewer, body) => service.view(viewer, body));
}
