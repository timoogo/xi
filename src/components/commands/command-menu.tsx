"use client";

import { createCommandEngine, type RegistryCommandEngine } from "@cmdly/core";
import { useCommandEngine } from "@cmdly/react";
import { ArrowLeft, Command, Loader2, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { createXiCommandRuntime, xiCommands, type XiCommandRuntime } from "@/lib/commands/registry";
import { cn } from "@/lib/utils";

type Engine = RegistryCommandEngine<XiCommandRuntime, true>;

/**
 * Command palette: a rail button and Ctrl/⌘+K open it. It knows no command: it renders whatever
 * the Cmdly engine exposes (menu, step, loading, error, final). A Cmdly engine cannot be reopened
 * after close, so each opening creates one and unmounting destroys it.
 */
export function CommandMenu({ className }: { className?: string }) {
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
  return <>
    <button type="button" onClick={() => setOpen(true)} title="Commandes (Ctrl+K)" aria-keyshortcuts="Control+K Meta+K"
      className={cn("group inline-flex items-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", className)}>
      <span className="inline-flex items-center gap-5 rounded-full p-3 text-xl text-foreground/80 transition-colors group-hover:bg-accent xl:pr-6">
        <Command aria-hidden="true" className="size-[26px]" strokeWidth={1.9} />
        <span className="hidden xl:inline">Commandes</span>
        <span className="sr-only xl:hidden">Commandes</span>
      </span>
    </button>
    <Dialog open={open} onOpenChange={setOpen}>{open ? <PaletteSession onClose={() => setOpen(false)} /> : null}</Dialog>
  </>;
}

function PaletteSession({ onClose }: { onClose: () => void }) {
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
  return engine ? <Palette engine={engine} onClose={onClose} /> : null;
}

const message = (error: unknown) => error instanceof Error ? error.message : "La commande a échoué.";

function Palette({ engine, onClose }: { engine: Engine; onClose: () => void }) {
  const { state, actions } = useCommandEngine(engine);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => { if (state.closed) onClose(); }, [state.closed, onClose]);
  useEffect(() => { if (state.phase !== "final") input.current?.focus(); }, [state.phase, state.step, state.command]);
  useEffect(() => { document.getElementById(`${listId}-${state.active}`)?.scrollIntoView?.({ block: "nearest" }); }, [listId, state.active, state.items]);

  const title = state.step?.label ?? (state.canBack ? state.menuLabel : "Commandes");
  const busy = state.loading || state.running;
  const failed = state.loadFailed || state.status === "error";
  const start = Math.floor(state.active / state.maxVisibleItems) * state.maxVisibleItems;
  const visible = state.items.slice(start, start + state.maxVisibleItems);
  const showList = state.phase !== "final" && !busy && !state.loadFailed;
  const back = () => { actions.back(); input.current?.focus(); };

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const count = state.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count) actions.setActive((state.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      actions.select(state.active);
    } else if (event.key === "Backspace" && !state.query && state.canBack && !state.running) {
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
        <input ref={input} autoFocus value={state.query} onChange={event => actions.setQuery(event.target.value)} onKeyDown={onKeyDown}
          disabled={state.running || state.phase === "final"} placeholder={title} aria-label={title}
          role="combobox" aria-expanded={showList} aria-controls={showList ? listId : undefined} aria-autocomplete="list"
          aria-activedescendant={showList && state.items.length ? `${listId}-${state.active}` : undefined}
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
          state.items.length ? (
            <ul role="listbox" id={listId} aria-label={title} className="space-y-0.5">
              {visible.map((item, offset) => {
                const index = start + offset;
                return (
                  <li key={"id" in item ? item.id : item.value} id={`${listId}-${index}`} role="option" aria-selected={index === state.active}
                    onClick={() => actions.select(index)} onMouseMove={() => { if (index !== state.active) actions.setActive(index); }}
                    className="cursor-pointer truncate rounded-md px-3 py-2 text-[15px] aria-selected:bg-accent aria-selected:text-accent-foreground">
                    {item.label}
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
