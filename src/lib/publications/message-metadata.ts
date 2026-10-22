import { parseDocument } from "yaml";
import { splitFrontmatter } from "./markdown";
import { MESSAGE_REF } from "../graph/types";

export function parseMessage(file: string, body: string) {
  const { yaml } = splitFrontmatter(body);
  const document = yaml ? parseDocument(yaml) : null;
  const raw = document && !document.errors.length ? document.toJS() : null;
  const reply = raw && typeof raw === "object" ? raw.reply_to : null;
  const timestamp = (key: string) => typeof raw?.[key] === "string" && Number.isFinite(Date.parse(raw[key])) ? new Date(raw[key]).toISOString() : undefined;
  return { file, body, ...(timestamp("created_at") ? {createdAt: timestamp("created_at")} : {}), ...(timestamp("updated_at") ? {updatedAt: timestamp("updated_at")} : {}), replyTo: typeof reply === "string" && MESSAGE_REF.test(reply) ? reply : null };
}
