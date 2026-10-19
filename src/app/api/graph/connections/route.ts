import { parseConnectionsRequest } from "@/lib/graph/engine";
import { graphResponse, readJson } from "@/lib/graph/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return graphResponse(parseConnectionsRequest(await readJson(request)), (service, viewer, body) => service.connections(viewer, body));
}
