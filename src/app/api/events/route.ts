import { randomUUID } from "node:crypto";
import { getAuth } from "@/lib/auth";
import { changedPublications, removedPublications, encodeSync, type RealtimeState } from "@/lib/publications/events";
import { privateJson } from "@/lib/publications/http";
import { getPublicationStore, getViewer } from "@/lib/publications/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A graceful shutdown waits for open responses: end every stream so a restart is not held
// by idle tabs. EventSource reconnects to the next process and reconciles from scratch.
// New streams are refused meanwhile, or a reconnect on a kept-alive socket would hold it again.
const shutdown = globalThis as typeof globalThis & { xiEventStreams?: { open: Set<() => void>; closing: boolean } };
if (!shutdown.xiEventStreams) {
  const state: { open: Set<() => void>; closing: boolean } = shutdown.xiEventStreams = { open: new Set(), closing: false };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { state.closing = true; state.open.forEach(close => close()); });
}
const { open: streams } = shutdown.xiEventStreams;

export async function GET(request: Request) {
  if (shutdown.xiEventStreams?.closing) {
    return Response.json({ error: "Redémarrage en cours." }, { status: 503, headers: { "Cache-Control": "private, no-store", Connection: "close" } });
  }
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Session requise." }, 401);
  const store = await getPublicationStore();
  let previous: RealtimeState;
  try {
    previous = await store.realtimeState(viewer);
  } catch {
    return privateJson({ error: "Synchronisation indisponible." }, 503);
  }
  const encoder = new TextEncoder();
  // Epoch + increasing sequence prevents a server restart from reusing event identities.
  const epoch = randomUUID();
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let lastHeartbeat = Date.now();
  const stop = () => {
    stopped = true;
    streams.delete(abort);
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  };
  let abort = () => stop();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      const close = () => {
        stop();
        try { controller.close(); } catch { /* Already cancelled. */ }
      };
      abort = close;
      streams.add(close);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) return close();
      send("retry: 1500\n\n");
      // A state reconciliation on every connect also recovers all missed events,
      // including across restart or a cursor older than any retained journal.
      // No historical bodies are replayed after permissions have changed.
      send(encodeSync({ version: `${epoch}:${++sequence}`, publications: [], reset: true }));
      const tick = async () => {
        if (stopped) return;
        try {
          // An open stream must not outlive a revoked/expired Better Auth session.
          const session = await getAuth().api.getSession({ headers: request.headers });
          if (!session || session.user.id !== viewer.id) {
            send(`event: session\ndata: {"expired":true}\n\n`);
            return close();
          }
          const current = await store.realtimeState(viewer);
          if (stopped) return;
          const publications = changedPublications(previous, current);
          const reset = previous.settingsRevision !== current.settingsRevision;
          if (publications.length || reset) {
            send(encodeSync({ version: `${epoch}:${++sequence}`, publications, removed: removedPublications(previous, current), ...(reset ? { reset: true } : {}) }));
          }
          previous = current;
          if (Date.now() - lastHeartbeat >= 15_000) {
            send(": heartbeat\n\n");
            lastHeartbeat = Date.now();
          }
        } catch {
          // Closing prompts EventSource's built-in retry and a fresh reconciliation.
          return close();
        }
        if (!stopped) {
          timer = setTimeout(tick, 1000);
          timer.unref();
        }
      };
      timer = setTimeout(tick, 1000);
      timer.unref();
    },
    cancel() { stop(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "private, no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    Vary: "Cookie",
  } });
}
