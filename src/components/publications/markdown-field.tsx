"use client";

import { Bold, Check, Code, Heading2, Italic, Link2, List, Quote, SquareDashedBottom } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MarkdownView } from "./markdown-view";

type Format = { label: string; icon: ReactNode; wrap?: [string, string]; prefix?: string };

const FORMATS: Format[] = [
  { label: "Gras", icon: <Bold />, wrap: ["**", "**"] },
  { label: "Italique", icon: <Italic />, wrap: ["*", "*"] },
  { label: "Titre", icon: <Heading2 />, prefix: "## " },
  { label: "Liste à puces", icon: <List />, prefix: "- " },
  { label: "Citation", icon: <Quote />, prefix: "> " },
  { label: "Code en ligne", icon: <Code />, wrap: ["`", "`"] },
  { label: "Lien web", icon: <Link2 />, wrap: ["[", "](https://)"] },
  { label: "Lien Obsidian", icon: <SquareDashedBottom />, wrap: ["[[", "]]"] },
];

/** Formatting only inserts Markdown syntax: the stored text stays exactly what the author sees in raw mode. */
function applyFormat(value: string, start: number, end: number, format: Format) {
  if (format.wrap) {
    const [before, after] = format.wrap;
    return { value: value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end), start: start + before.length, end: end + before.length };
  }
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const prefix = format.prefix!;
  const lines = value.slice(lineStart, end).split("\n").map((line) => prefix + line).join("\n");
  return { value: value.slice(0, lineStart) + lines + value.slice(end), start: start + prefix.length, end: lineStart + lines.length };
}

const textareaClass = "min-h-32 w-full resize-y rounded-md border bg-transparent px-3 py-2 text-base outline-none [field-sizing:content] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm";

/**
 * Visual mode: rendered Markdown that turns into a formatted editor on click or Enter.
 * The parent keeps one block active; blurring does not collapse it, because the resulting
 * layout shift would swallow the click that caused the blur.
 */
export function VisualMarkdownField({ label, value, onChange, placeholder, editing, onEditingChange }: {
  label: string; value: string; onChange: (value: string) => void; placeholder: string;
  editing: boolean; onEditingChange: (editing: boolean) => void;
}) {
  const setEditing = onEditingChange;
  const textarea = useRef<HTMLTextAreaElement>(null);

  function format(item: Format) {
    const element = textarea.current;
    if (!element) return;
    const next = applyFormat(value, element.selectionStart, element.selectionEnd, item);
    onChange(next.value);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.start, next.end);
    });
  }

  if (!editing) {
    return (
      <div
        role="button" tabIndex={0} aria-label={`Modifier « ${label} »`}
        onClick={() => setEditing(true)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setEditing(true); } }}
        className="min-h-16 cursor-text rounded-md border border-transparent p-3 hover:border-border focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {value.trim() ? <MarkdownView markdown={value} /> : <p className="text-muted-foreground">{placeholder}</p>}
      </div>
    );
  }
  return (
    <div>
      <div role="toolbar" aria-label={`Mise en forme : ${label}`} className="mb-1 flex flex-wrap items-center gap-1">
        {FORMATS.map((item) => (
          <button key={item.label} type="button" title={item.label} aria-label={item.label} onMouseDown={(event) => event.preventDefault()} onClick={() => format(item)}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4">
            {item.icon}
          </button>
        ))}
        <button type="button" onClick={() => setEditing(false)}
          className="ml-auto inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4">
          <Check aria-hidden="true" />Terminé
        </button>
      </div>
      <textarea ref={textarea} autoFocus aria-label={label} value={value} placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }}
        className={textareaClass} />
    </div>
  );
}

/** Raw mode: the exact file text, monospace, nothing interpreted. */
export function RawMarkdownField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; editing?: boolean; onEditingChange?: (editing: boolean) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-xs text-muted-foreground">{label}</span>
      <textarea value={value} spellCheck={false} onChange={(event) => onChange(event.target.value)} className={cn(textareaClass, "font-mono text-sm md:text-sm")} />
    </label>
  );
}
