/** Text spans for the composer and published comments. URL/email fragments stay ordinary text. */
export type Reference = { start: number; end: number; text: string; kind: "mention" | "topic" };
export function references(text: string): Reference[] {
  const found: Reference[] = [];
  const pattern = /(^|[\s([{"'«,;:!?])([@#][\p{L}\p{N}_.-]*)/gu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1].length;
    // A valid-looking token after punctuation can still belong to a URL or email.
    let wordStart = start;
    while (wordStart > 0 && !/\s/u.test(text[wordStart - 1])) wordStart--;
    const prefix = text.slice(wordStart, start);
    if (/(?:https?:\/\/|www\.)\S*$/i.test(prefix) || /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]*$/u.test(prefix)) continue;
    found.push({ start, end: start + match[2].length, text: match[2], kind: match[2][0] === "@" ? "mention" : "topic" });
  }
  return found;
}
