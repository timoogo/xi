import { z } from "zod";
import type { JobQueue } from "../watch/jobs";
import { PRIORITY } from "../watch/jobs";
import { SYSTEM_TASK_KIND } from "../watch/orchestrator";

/**
 * How a system ΞAgent task sits on the watch engine's queue (`watch_job`, kind `system-task`):
 * its key makes a request idempotent per (agent, requester, requestId). `manual`: asked by the
 * user (or a conversation turn), counted against their open requests; `review`: planned by Ξ
 * (Konstruktor's proactive reviews), at ordinary priority so it never delays a user's request;
 * `major-event`: asked by the editorial pipeline (an arbitration by @arbitre), first in line since
 * the news waits for it.
 */
export const payloadSchema = z.object({ agentId: z.string(), kind: z.string(), task: z.string(), owner: z.string(), requestId: z.uuid(), input: z.unknown(), trigger: z.enum(["manual", "review", "major-event"]) });
export type SystemTaskPayload = z.infer<typeof payloadSchema>;
export const systemTaskKey = (kind: string, owner: string, requestId: string) => `system:${kind}:${owner}:${requestId}`;

export function enqueueSystemTask(queue: JobQueue, payload: SystemTaskPayload) {
  return queue.enqueue({ kind: SYSTEM_TASK_KIND, key: systemTaskKey(payload.kind, payload.owner, payload.requestId), payload, priority: payload.trigger === "major-event" ? PRIORITY.major : payload.trigger === "manual" ? PRIORITY.manual : PRIORITY.ordinary, maxAttempts: 3 });
}
