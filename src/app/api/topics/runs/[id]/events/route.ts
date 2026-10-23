import { runEvents } from "@/lib/topics/run-events";
import { getTopicStore } from "@/lib/topics/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return runEvents(request, (await context.params).id, getTopicStore); }
