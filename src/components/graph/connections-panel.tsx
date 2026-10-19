"use client";

import { ChevronLeft, ChevronRight, ListTree, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { canGoBack, canGoForward, currentEntry, type MessageHistory, type PanelState } from "@/lib/graph/local-state";
import type { ConnectionsFilters, MessageRef, NodeId } from "@/lib/graph/types";
import { cn } from "@/lib/utils";
import { ConnectionsList } from "./connections-list";
import { MessagePreviewView } from "./message-preview";
import { scopeTitle } from "./model";

const iconButton = "inline-flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-accent disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * Non-modal side sheet (bottom sheet below `sm`) laid over the canvas: the graph stays interactive and never
 * resizes. Back/Forward walk the message history only; the connections list is a separate route.
 */
export function ConnectionsPanel({ panel, history, focusToken, generators, labelFor, onClose, onBack, onForward, onShowConnections, onOpenMessage, onFilters }: {
  panel: PanelState;
  history: MessageHistory;
  /** Changes when a user action opened or re-routed the panel: focus then moves to its title. */
  focusToken: number;
  generators: { id: string; label: string }[];
  labelFor: (id: NodeId) => string;
  onClose: () => void;
  onBack: () => void;
  onForward: () => void;
  onShowConnections: () => void;
  onOpenMessage: (ref: MessageRef) => void;
  onFilters: (filters: ConnectionsFilters) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusToken) titleRef.current?.focus({ preventScroll: true });
  }, [focusToken]);

  const ref = currentEntry(history);
  const showMessage = panel.view === "message" && ref !== null;
  const connections = panel.connections;
  // From the list, Back reopens the current message of the history.
  const backEnabled = showMessage ? canGoBack(history) : ref !== null;
  const forwardEnabled = showMessage && canGoForward(history);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  };

  return (
    <aside aria-labelledby="graph-panel-title" onKeyDown={onKeyDown}
      className={cn("absolute inset-x-0 bottom-0 z-50 flex max-h-[62%] min-h-[40%] flex-col rounded-t-2xl border-t bg-background shadow-[0_-8px_30px_-12px_rgb(0_0_0/0.25)]",
        "sm:z-30 sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(400px,55%)] sm:rounded-none sm:border-l sm:border-t-0 sm:shadow-[-8px_0_30px_-16px_rgb(0_0_0/0.25)]")}>
      <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border sm:hidden" />
      <header className="flex items-center gap-1 border-b px-2 py-2">
        <button type="button" className={iconButton} onClick={onBack} disabled={!backEnabled} aria-label={showMessage ? "Message précédent" : "Revenir au dernier message"} title="Précédent">
          <ChevronLeft aria-hidden="true" className="size-5" />
        </button>
        <button type="button" className={iconButton} onClick={onForward} disabled={!forwardEnabled} aria-label="Message suivant" title="Suivant">
          <ChevronRight aria-hidden="true" className="size-5" />
        </button>
        <h2 id="graph-panel-title" ref={titleRef} tabIndex={-1} className="min-w-0 flex-1 truncate px-1 text-[15px] font-bold outline-none">
          {showMessage ? "Message" : "Connexions"}
        </h2>
        {showMessage && connections ? (
          <button type="button" className={cn(iconButton, "w-auto gap-1.5 px-2.5 text-[13px] font-medium")} onClick={onShowConnections}>
            <ListTree aria-hidden="true" className="size-4" />Liste
          </button>
        ) : null}
        <button type="button" className={iconButton} onClick={onClose} aria-label="Fermer le panneau" title="Fermer">
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {showMessage ? (
          <MessagePreviewView key={ref} messageRef={ref} onOpenMessage={onOpenMessage} />
        ) : connections ? (
          <>
            <p className="mb-3 text-[13.5px] font-medium leading-snug">{scopeTitle(connections.scope, labelFor)}</p>
            <ConnectionsList scope={connections.scope} filters={connections.filters} onFilters={onFilters} generators={generators} currentRef={ref} onOpenMessage={onOpenMessage} />
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">Choisissez un compteur sur le graphe pour afficher les connexions correspondantes.</p>
        )}
      </div>
    </aside>
  );
}
