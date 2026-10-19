// Dependency-free Obsidian link helpers, shared by the server and the browser.

export function rewriteFolderLinks(text: string, from: string, to: string) {
  return text.split(`[[${from}/`).join(`[[${to}/`);
}

/** `[[path/to/note#heading|Alias]]` is shown as "Alias", otherwise as "note". */
export function wikilinkLabel(inner: string) {
  const [target, alias] = inner.split("|");
  if (alias?.trim()) return alias.trim();
  const path = target.split("#")[0].trim();
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "") || target.trim();
}

export function stripFrontmatter(text: string) {
  const match = /^---\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/m.exec(text);
  return match && match.index === 0 ? text.slice(match[0].length) : text;
}
