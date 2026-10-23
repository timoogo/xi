import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownImage } from "./markdown-image";
import Link from "next/link";
import { stripFrontmatter, wikilinkLabel } from "@/lib/publications/links";

const WIKILINK_PREFIX = "xi-wikilink:";

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };
/** Transform text nodes only: mentions inside code, URLs and existing links stay literal. */
function remarkMentions() {
  return (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      if (!node.children || ["link", "linkReference", "code", "inlineCode"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const parts: MarkdownNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(/(?<![\w@])@([a-z0-9]+(?:[.-][a-z0-9]+)*)/gi)) {
          if (match.index > offset) parts.push({ type: "text", value: child.value.slice(offset, match.index) });
          parts.push({ type: "link", url: `/dashboard/profiles?handle=${encodeURIComponent(match[1])}`, children: [{ type: "text", value: match[0] }] });
          offset = match.index + match[0].length;
        }
        if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    }
    visit(tree);
  };
}

/**
 * Obsidian links become ordinary Markdown links with a private scheme before parsing, so the
 * Markdown parser cannot reinterpret their paths (underscores, brackets). Code is left untouched.
 */
function protectWikilinks(markdown: string) {
  return markdown.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part.replace(
    /(!?)\[\[([^\]\n]+)\]\]/g,
    (_, embed: string, inner: string) => `[${(embed ? "↳ " : "") + wikilinkLabel(inner).replace(/[\\[\]*_`<>]/g, "\\$&")}](${WIKILINK_PREFIX}${encodeURIComponent(inner)})`,
  )).join("");
}

const components: Components = {
  a({ href, children }) {
    if (href?.startsWith("/dashboard/profiles?handle=")) return <Link href={href}>{children}</Link>;
    if (href?.startsWith(WIKILINK_PREFIX)) {
      return <span className="xi-wikilink" title={`Obsidian: ${decodeURIComponent(href.slice(WIKILINK_PREFIX.length))}`}>{children}</span>;
    }
    return <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
  },
  // Vault assets are not served; HTTPS media requires explicit reader consent.
  img({ src, alt }) {
    return <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />;
  },
};

// Raw HTML is never rendered (react-markdown's default); URLs go through its sanitizer.
export function MarkdownView({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div className={`xi-markdown ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMentions]}
        components={components}
        urlTransform={(url) => url.startsWith(WIKILINK_PREFIX) ? url : defaultUrlTransform(url)}
      >
        {protectWikilinks(stripFrontmatter(markdown))}
      </ReactMarkdown>
    </div>
  );
}
