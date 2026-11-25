import { topicResponse } from "@/lib/topics/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The same visible catalogue used by topic search, including the viewer's personal topics. */
export async function GET(request: Request) {
  return topicResponse(request, async (store, owner) => {
    const { personal, shared } = await store.visible(owner);
    return { topics: [...personal.map(({ id, name, tag }) => ({ id, name, tag, personal: true })), ...shared.map(({ id, name, tag }) => ({ id, name, tag, personal: false }))] };
  });
}
