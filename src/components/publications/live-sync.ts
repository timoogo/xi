"use client";
import { useEffect, useRef } from "react";
export type SyncEvent = { version: string; publications?: string[]; reset?: boolean; removed?: string[] };
/** One connection for mounted views, closed when its final subscriber leaves. */
const listeners = new Set<(event: SyncEvent) => void>();
let source: EventSource | null = null;
let version = "";
let retry: ReturnType<typeof setTimeout> | undefined;
let delay = 2_000;
function connect() {
  version = "";
  const current = source = new EventSource("/api/events");
  current.addEventListener("session", () => { disconnect(); location.replace("/auth/login"); });
  current.addEventListener("sync", event => {
    delay = 2_000;
    try {
      const data = JSON.parse((event as MessageEvent).data) as SyncEvent;
      const [epoch, sequence] = data.version.split(":");
      const [previousEpoch, previousSequence] = version.split(":");
      if (!data.reset && epoch === previousEpoch && Number(sequence) <= Number(previousSequence)) return;
      version = data.version;
      listeners.forEach(fn => fn(data));
    } catch { /* Invalid frames do not alter the readable state. */ }
  });
  // EventSource retries dropped streams itself but gives up for good on a non-200 answer
  // (restart, transient 503): reconnect with backoff; the server's reset reconciles.
  current.addEventListener("error", () => {
    if (current.readyState !== EventSource.CLOSED || source !== current) return;
    source = null;
    retry = setTimeout(() => { retry = undefined; if (listeners.size) connect(); }, delay);
    delay = Math.min(delay * 2, 60_000);
  });
}
function disconnect() {
  source?.close(); source = null; version = "";
  if (retry) clearTimeout(retry);
  retry = undefined;
}
export function useLiveSync(onSync: (event: SyncEvent) => void) {
  const callback = useRef(onSync);
  useEffect(() => { callback.current = onSync; }, [onSync]);
  useEffect(() => {
    const listener = (event: SyncEvent) => callback.current(event);
    listeners.add(listener);
    if (!source && !retry) connect();
    return () => { listeners.delete(listener); if (!listeners.size) disconnect(); };
  }, []);
}
