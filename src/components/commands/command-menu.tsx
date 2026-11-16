"use client";

import { createCommandEngine, type RegistryCommandEngine } from "@cmdly/core";
import { useCommandEngine } from "@cmdly/react";
import { ArrowLeft, Command, Loader2, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { commandTags, type CommandTag } from "@/lib/commands/tags";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { createXiCommandRuntime, xiCommands, type XiCommandRuntime } from "@/lib/commands/registry";
import { cn } from "@/lib/utils";

type Engine = RegistryCommandEngine<XiCommandRuntime, true>;

/** Open state of the single palette; Ctrl/⌘+K toggles it. Every trigger opens this same palette. */
export function useCommandMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(value => !value);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return { open, setOpen };
}

export function CommandRailButton({ onOpen, className }: { onOpen: () => void; className?: string }) {
  return (
    <button type="button" onClick={onOpen} title="Commandes (Ctrl+K)" aria-keyshortcuts="Control+K Meta+K"
      className={cn("group inline-flex items-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", className)}>
      <span className="inline-flex items-center gap-5 rounded-full p-3 text-xl text-foreground/80 transition-colors group-hover:bg-accent xl:pr-6">
        <Command aria-hidden="true" className="size-[26px]" strokeWidth={1.9} />
        <span className="hidden xl:inline">Commandes</span>
        <span className="sr-only xl:hidden">Commandes</span>
      </span>
    </button>
  );
}

/**
 * The command palette. It knows no command: it renders whatever the Cmdly engine exposes (menu,
 * step, loading, error, final). A Cmdly engine cannot be reopened after close, so each opening
 * creates one and closing destroys it: there is never more than one engine.
 */
export function CommandMenu({ open, onOpenChange, showBusinessTags = false }: { open: boolean; onOpenChange: (open: boolean) => void; showBusinessTags?: boolean }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>{open ? <PaletteSession showBusinessTags={showBusinessTags} onClose={() => onOpenChange(false)} /> : null}</Dialog>;
}

function PaletteSession({ onClose, showBusinessTags }: { onClose: () => void; showBusinessTags: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const location = useRef(pathname);
  location.current = pathname;
  const [engine, setEngine] = useState<Engine | null>(null);
  useEffect(() => {
    // Created in the effect so Strict Mode's replay destroys the first engine and creates a fresh one.
    const instance = createCommandEngine({ registry: xiCommands, runtime: () => createXiCommandRuntime({ navigate: href => router.push(href), pathname: location.current }) });
    setEngine(instance);
    return () => instance.destroy();
  }, [router]);
  return engine ? <Palette engine={engine} onClose={onClose} showBusinessTags={showBusinessTags} /> : null;
}

const message = (error: unknown) => error instanceof Error ? error.message : "La commande a échoué.";

function Palette({ engine, onClose, showBusinessTags }: { engine: Engine; onClose: () => void; showBusinessTags: boolean }) {
  const { state, actions } = useCommandEngine(engine);
  const input = useRef<HTMLInputElement>(null);
  const [tagQuery, setTagQuery] = useState("");
  const listId = useId();
  useEffect(() => { if (state.closed) onClose(); }, [state.closed, onClose]);
  useEffect(() => { setTagQuery(""); }, [state.phase, state.step]);
  useEffect(() => { if (state.phase !== "final") input.current?.focus(); }, [state.phase, state.step, state.command]);
  useEffect(() => { document.getElementById(`${listId}-${state.active}`)?.scrollIntoView?.({ block: "nearest" }); }, [listId, state.active, state.items]);

  const title = state.step?.label ?? (state.canBack ? state.menuLabel : "Commandes");
  const busy = state.loading || state.running;
  const failed = state.loadFailed || state.status === "error";
  const tag = state.phase === "menu" && tagQuery in commandTags ? tagQuery as CommandTag : null;
  const indices = state.items.map((_, index) => index).filter(index => !tag || ("id" in state.items[index] && xiCommands.resolve((state.items[index] as { id: string }).id)?.command.tags?.includes(tag)));
  const activePosition = Math.max(0, indices.indexOf(state.active));
  const start = Math.floor(activePosition / state.maxVisibleItems) * state.maxVisibleItems;
  const visible = indices.slice(start, start + state.maxVisibleItems);
  const showList = state.phase !== "final" && !busy && !state.loadFailed;
  const back = () => { actions.back(); input.current?.focus(); };

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const count = indices.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count) actions.setActive(indices[(activePosition + (event.key === "ArrowDown" ? 1 : count - 1)) % count]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (count) actions.select(indices[activePosition]);
    } else if (event.key === "Backspace" && !state.query && !tagQuery && state.canBack && !state.running) {
      event.preventDefault();
      back();
    }
  }

  return (
    <DialogContent showCloseButton={false} aria-busy={busy}
      className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      // Escape goes back one step before it closes the palette.
      onEscapeKeyDown={event => { if (state.canBack && !state.running) { event.preventDefault(); back(); } }}>
      <DialogTitle className="sr-only">Palette de commandes</DialogTitle>
      <DialogDescription className="sr-only">Tapez pour filtrer, flèches pour choisir, Entrée pour valider, Échap pour revenir en arrière.</DialogDescription>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {state.canBack
          ? <Button type="button" variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Étape précédente" onClick={back} disabled={state.running}><ArrowLeft aria-hidden="true" /></Button>
          : <Search aria-hidden="true" className="size-5 text-muted-foreground" />}
        <input ref={input} autoFocus value={tagQuery || state.query} onChange={event => { const value = event.target.value; const isTag = state.phase === "menu" && value.toLowerCase() in commandTags; setTagQuery(isTag ? value.toLowerCase() : ""); actions.setQuery(isTag ? "" : value); }} onKeyDown={onKeyDown}
          disabled={state.running || state.phase === "final"} placeholder={title} aria-label={title}
          role="combobox" aria-expanded={showList} aria-controls={showList ? listId : undefined} aria-autocomplete="list"
          aria-activedescendant={showList && indices.length ? `${listId}-${indices[activePosition]}` : undefined}
          className="h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground disabled:opacity-60" />
        {state.progress && !state.progress.indeterminate && state.progress.total
          ? <span className="shrink-0 text-xs text-muted-foreground">Étape {Math.min(state.progress.current + 1, state.progress.total)}/{state.progress.total}</span> : null}
      </div>

      <div className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
        {state.phase === "final" && state.finalStep && state.summary.length ? (
          <dl className="space-y-1 p-2 text-sm">{state.summary.map(item => <div key={item.id} className="flex gap-2"><dt className="text-muted-foreground">{item.label}</dt><dd className="font-medium">{item.value}</dd></div>)}</dl>
        ) : null}
        {busy ? <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin" />{state.running ? "Exécution…" : "Chargement…"}</p> : null}
        {state.error && !busy ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 p-3 text-sm text-destructive">
            <span className="min-w-0 flex-1">{message(state.error)}</span>
            {failed ? <Button type="button" size="sm" variant="outline" onClick={actions.retry}>Réessayer</Button> : null}
          </div>
        ) : null}
        {state.phase === "final" && state.finalStep?.timing === "before" && state.status !== "loading" && !failed
          ? <div className="p-2"><Button type="button" onClick={() => void actions.execute()}>Confirmer</Button></div> : null}
        {showList ? (
          indices.length ? (
            <ul role="listbox" id={listId} aria-label={title} className="space-y-0.5">
              {visible.map(index => {
                const item = state.items[index];
                const resolved = state.phase === "menu" && "id" in item ? xiCommands.resolve(item.id) : undefined;
                const origin = resolved?.isGlobal ? "" : resolved?.sourceRegistry;
                const registryBadge = origin === "publications" ? { label: "Publications", className: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100" } : origin === "xiagents" ? { label: "ΞAgents", className: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-100" } : { label: "Global", className: "" };
                return (
                  <li key={"id" in item ? item.id : item.value} id={`${listId}-${index}`} role="option" aria-label={item.label} aria-selected={index === indices[activePosition]}
                    onClick={() => actions.select(index)} onMouseMove={() => { if (index !== state.active) actions.setActive(index); }}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-[15px] aria-selected:bg-accent aria-selected:text-accent-foreground">
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {resolved ? <Badge className={registryBadge.className}>{registryBadge.label}</Badge> : null}
                    {resolved && showBusinessTags ? resolved.command.tags?.map(key => {
                      const def = { ...resolved.tagCatalog[key], ...resolved.command.tagOverrides?.[key] };
                      return <Badge key={key} variant={def.variant} className={def.className} style={{ ...def.style, ...(def.color ? { color: def.color } : {}) }}>{def.label ?? key}</Badge>;
                    }) : null}
                  </li>
                );
              })}
            </ul>
          ) : <p className="p-3 text-sm text-muted-foreground">{state.query ? `Aucun résultat pour « ${state.query} ».` : "Aucun élément disponible."}</p>
        ) : null}
      </div>
    </DialogContent>
  );
}
