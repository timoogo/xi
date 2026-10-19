import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripFrontmatter, wikilinkLabel } from "@/lib/publications/links";

const WIKILINK_PREFIX = "xi-wikilink:";

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
    if (href?.startsWith(WIKILINK_PREFIX)) {
      return <span className="xi-wikilink" title={`Obsidian: ${decodeURIComponent(href.slice(WIKILINK_PREFIX.length))}`}>{children}</span>;
    }
    return <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
  },
  // Images would load third-party URLs from untrusted Markdown; vault assets are not served yet.
  img({ alt }) {
    return <span className="xi-wikilink">{alt ? `[image: ${alt}]` : "[image]"}</span>;
  },
};

// Raw HTML is never rendered (react-markdown's default); URLs go through its sanitizer.
export function MarkdownView({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div className={`xi-markdown ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={(url) => url.startsWith(WIKILINK_PREFIX) ? url : defaultUrlTransform(url)}
      >
        {protectWikilinks(stripFrontmatter(markdown))}
      </ReactMarkdown>
    </div>
  );
}
