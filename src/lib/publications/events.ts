export type RealtimeState = {
  version: string;
  settingsRevision?: string;
  publications: { id: string; revision: string }[];
};
export type SyncEvent = { version: string; publications: string[]; removed?: string[]; reset?: boolean };

/**
 * Compare authorized projections, never raw global changes. A private write cannot
 * produce an ID, count or notification for a viewer who could not read it.
 * Removed IDs are only disclosed to a connection that already knew them.
 */
export function changedPublications(previous: RealtimeState, current: RealtimeState) {
  const before = new Map(previous.publications.map(item => [item.id, item.revision]));
  const after = new Map(current.publications.map(item => [item.id, item.revision]));
  return [...new Set([
    ...current.publications.filter(item => before.get(item.id) !== item.revision).map(item => item.id),
    ...previous.publications.filter(item => !after.has(item.id)).map(item => item.id),
  ])];
}

export function removedPublications(previous: RealtimeState, current: RealtimeState) {
  const accessible = new Set(current.publications.map(item => item.id));
  return previous.publications.filter(item => !accessible.has(item.id)).map(item => item.id);
}

export function encodeSync(event: SyncEvent) {
  return `id: ${event.version}\nevent: sync\ndata: ${JSON.stringify(event)}\n\n`;
}
