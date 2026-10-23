type Snapshot = { id: string; events: unknown[]; state: string };
/** Full snapshots reconcile state on every connection; event IDs permit log deduplication. */
export function encodeRun(run: Snapshot) {
  return `id: ${run.id}:${run.events.length}:${run.state}\nevent: pipeline\ndata: ${JSON.stringify(run)}\n\n`;
}
export function eventCursor(run: Snapshot) { return `${run.id}:${run.events.length}:${run.state}`; }
