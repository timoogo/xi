export type ConversationMessage = { key: string; body: string; replyTo?: string | null };

/** File numbers are immutable identities; display order must never become an identity. */
export function messageAnchor(key: string): string | null {
  const match = /^([1-9]\d*)_/.exec(key.split("/").pop() ?? "");
  return match ? `m-${match[1]}` : null;
}

/** Only existing, acyclic local references form branches. Malformed links retain their content. */
export function conversationTree(messages: ConversationMessage[], publicationId?: string) {
  const byRef = new Map<string, ConversationMessage>(messages.flatMap(message => {
    const anchor = messageAnchor(message.key);
    return anchor && publicationId ? [[`${publicationId}/${anchor.slice(2)}`, message] as const] : [];
  }));
  const parents = new Map<string, ConversationMessage>();
  for (const message of messages) {
    const parent = message.replyTo ? byRef.get(message.replyTo) : undefined;
    if (!parent || parent === message) continue;
    const seen = new Set([message.key]);
    let current: ConversationMessage | undefined = parent;
    while (current && !seen.has(current.key)) {
      seen.add(current.key);
      current = current.replyTo ? byRef.get(current.replyTo) : undefined;
    }
    if (!current) parents.set(message.key, parent);
  }
  const branches = new Map<string, ConversationMessage[]>();
  for (const message of messages) {
    const parent = parents.get(message.key);
    if (parent) branches.set(parent.key, [...(branches.get(parent.key) ?? []), message]);
  }
  return { main: messages.filter(message => !parents.has(message.key)), branches };
}

/** A publication's own thread: messages not attached to a local message, in thread order. */
export function threadNumbers(messages: { file: string; body: string; replyTo?: string | null }[], publicationId: string): number[] {
  const tree = conversationTree(messages.map(message => ({ key: message.file, body: message.body, replyTo: message.replyTo })), publicationId);
  return [...new Set(tree.main.map(message => parseInt(message.key, 10)))];
}
