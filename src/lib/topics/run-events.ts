import { getAuth } from "@/lib/auth";
import { privateJson } from "@/lib/publications/http";
import { getViewer } from "@/lib/publications/server";
import { encodeRun, eventCursor } from "@/lib/topics/events";

export async function runEvents(request: Request, id: string, getStore: () => Promise<{ getRun: (owner: string, id: string) => Promise<{ id: string; events: unknown[]; state: string }> }>) {
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Session requise." }, 401);
  const store = await getStore();
  try { await store.getRun(viewer.id, id); } catch { return privateJson({ error: "Exécution introuvable." }, 404); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let close = () => { closed = true; if (timer) clearTimeout(timer); };
  const encoder = new TextEncoder();
  // Snapshot replay deliberately supersedes Last-Event-ID: no journal retention gap or restart gap.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => { closed = true; if (timer) clearTimeout(timer); request.signal.removeEventListener("abort", close); };
      close = () => { cleanup(); try { controller.close(); } catch { /* cancelled */ } };
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) return close();
      controller.enqueue(encoder.encode("retry: 1500\n\n"));
      let previous = "";
      const opened = Date.now();
      const tick = async () => {
        if (closed) return;
        try {
          const session = await getAuth().api.getSession({ headers: request.headers });
          if (closed) return;
          if (session?.user.id !== viewer.id) return close();
          const run = await store.getRun(viewer.id, id);
          if (closed) return;
          const cursor = eventCursor(run);
          if (cursor !== previous) { controller.enqueue(encoder.encode(encodeRun(run))); previous = cursor; }
          else controller.enqueue(encoder.encode(": heartbeat\n\n"));
          // Bounded streams release deployments; EventSource reconnects and receives current state.
          if (Date.now() - opened > 25_000) return close();
          timer = setTimeout(tick, 500);
        } catch { close(); }
      };
      void tick();
    },
    cancel() { close(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store, no-transform", Vary: "Cookie", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
}
