"use client";

import { Filter, Layers, List, Maximize2, Minus, Network, Plus, Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LayoutMode } from "@/lib/graph/local-state";
import { SEMANTIC_TYPES, type NodeLevel, type SemanticType } from "@/lib/graph/types";
import { cn } from "@/lib/utils";
import { LEVEL_LABELS, TYPE_LABELS } from "./model";

const LEVELS: NodeLevel[] = ["generator", "publication", "message"];

export function GraphToolbar({ mode, onMode, lockedLevel, effectiveLevel, onLock, types, onTypes, listOpen, onList, onZoom, onFit }: {
  mode: LayoutMode;
  onMode: (mode: LayoutMode) => void;
  lockedLevel: NodeLevel | null;
  effectiveLevel: NodeLevel;
  onLock: (level: NodeLevel | null) => void;
  types: SemanticType[];
  onTypes: (types: SemanticType[]) => void;
  listOpen: boolean;
  onList: () => void;
  onZoom: (factor: number) => void;
  onFit: () => void;
}) {
  const chip = "h-8 rounded-full px-3 text-[13px]";
  return (
    <div role="toolbar" aria-label="Outils du graphe" className="flex flex-wrap items-center gap-1.5 border-b bg-background/90 px-3 py-2 backdrop-blur-md sm:px-4">
      <div role="group" aria-label="Disposition" className="flex rounded-full border p-0.5">
        {([["free", "Libre", Network], ["hierarchical", "Hiérarchique", Rows3]] as const).map(([value, label, Icon]) => (
          <button key={value} type="button" aria-pressed={mode === value} onClick={() => onMode(value)} title={`Disposition ${label.toLowerCase()}`}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
              mode === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
            <Icon aria-hidden="true" className="size-3.5" /><span className={value === "hierarchical" ? "hidden min-[420px]:inline" : undefined}>{label}</span>
          </button>
        ))}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={chip} aria-label={`Niveau de détail : ${lockedLevel ? `verrouillé sur ${LEVEL_LABELS[lockedLevel]}` : `automatique, ${LEVEL_LABELS[effectiveLevel]}`}`}>
            <Layers aria-hidden="true" />
            <span className="hidden sm:inline">{lockedLevel ? LEVEL_LABELS[lockedLevel] : `Auto · ${LEVEL_LABELS[effectiveLevel]}`}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Niveau de détail affiché</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={lockedLevel ?? "auto"} onValueChange={(value) => onLock(value === "auto" ? null : value as NodeLevel)}>
            <DropdownMenuRadioItem value="auto">Auto, selon le zoom</DropdownMenuRadioItem>
            {LEVELS.map((level) => <DropdownMenuRadioItem key={level} value={level}>Jusqu’aux {LEVEL_LABELS[level].toLowerCase()}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={cn(chip, types.length && "border-chart-2/60 text-chart-2")}
            aria-label={types.length ? `Types de relation : ${types.map((type) => TYPE_LABELS[type]).join(", ")}` : "Types de relation : tous"}>
            <Filter aria-hidden="true" />
            <span className="hidden sm:inline">{types.length ? `${types.length} type${types.length > 1 ? "s" : ""}` : "Tous les types"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Relations affichées</DropdownMenuLabel>
          {SEMANTIC_TYPES.map((type) => (
            <DropdownMenuCheckboxItem key={type} checked={types.includes(type)} onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => onTypes(checked ? [...types, type] : types.filter((other) => other !== type))}>
              {TYPE_LABELS[type]}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!types.length} onSelect={() => onTypes([])}>Afficher tous les types</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Zoom avant" title="Zoom avant" onClick={() => onZoom(1.25)}><Plus aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Zoom arrière" title="Zoom arrière" onClick={() => onZoom(0.8)}><Minus aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Recentrer le graphe" title="Recentrer le graphe" onClick={onFit}><Maximize2 aria-hidden="true" /></Button>
        <Button variant={listOpen ? "secondary" : "ghost"} size="sm" className={chip} aria-pressed={listOpen} onClick={onList} title="Liste textuelle des nœuds et des liens">
          <List aria-hidden="true" /><span className="hidden min-[420px]:inline">Liste</span>
        </Button>
      </div>
    </div>
  );
}
