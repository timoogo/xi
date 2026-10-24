"use client";

import { BloubBot, EXPRESSIONS, MAX_BLOCK, POSES, SEQUENCE, SHAPES, STEP, clampDuration, defaultCycle, makeBlock, minDurationOf, totalDuration, type Block, type StateId } from "bloub-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { OPEN_EYES_AT } from "@/lib/bloub/state-mapping";
import { BLOUB_ACTIVITIES, type BloubActivity, type BloubConfig } from "@/lib/bloub/types";
import { BLOUB_EYES } from "./bloub-avatar";
import { BloubPreview } from "./bloub-preview";
import { ACTIVITY_LABELS, ANIMATION_LABELS, EXPRESSION_LABELS, SHAPE_LABELS } from "./labels";

/** Still thumbnail: no animation loop, hidden from assistive tech (the button carries the name). */
function Tile({ children, label, pressed, onClick }: { children: ReactNode; label: string; pressed?: boolean; onClick: () => void }) {
  return <button type="button" aria-label={label} aria-pressed={pressed} onClick={onClick} title={label}
    className="flex flex-col items-center gap-1 rounded-xl border p-1.5 text-xs hover:bg-accent aria-pressed:border-foreground aria-pressed:bg-accent">
    <span aria-hidden="true" className="rounded-lg bg-[#e7e9ea]">{children}</span><span className="max-w-16 truncate">{label}</span>
  </button>;
}
const thumb = (props: Parameters<typeof BloubBot>[0]) => <BloubBot size={56} paper={BLOUB_EYES} frozenAt={OPEN_EYES_AT} aria-label="" {...props} />;

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <fieldset className="space-y-2"><legend className="font-semibold">{title}</legend><div className="flex flex-wrap gap-2">{children}</div></fieldset>;
}

/**
 * Studio-style editor of a Bloub appearance: shape, expression, activity
 * preview, demo sequences, playback, pointer follow and SVG export. Only
 * `value` / `onChange` are persisted by the host; everything else is a preview.
 * Colour is part of the configuration but intentionally not editable yet.
 */
export function BloubEditor({ value, onChange, name }: { value: BloubConfig; onChange: (value: BloubConfig) => void; name: string }) {
  const [activity, setActivity] = useState<BloubActivity>("idle");
  const [sequenceMode, setSequenceMode] = useState(false);
  const [blocks, setBlocks] = useState<Block[]>(() => defaultCycle().blocks);
  const [block, setBlock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(false);
  const preview = useRef<HTMLDivElement>(null);
  const update = (patch: Partial<BloubConfig>) => onChange({ ...value, ...patch });
  const editBlocks = (next: Block[], cursor = block) => { setBlocks(next); setBlock(Math.max(0, Math.min(cursor, next.length - 1))); if (!next.length) setPlaying(false); };
  function exportSvg() {
    const svg = preview.current?.querySelector("svg");
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: "bloub.svg" });
    link.click();
    URL.revokeObjectURL(url);
  }
  return <div className="space-y-5">
    <div className="flex flex-col items-start gap-3 sm:flex-row">
      <BloubPreview ref={preview} config={value} activity={activity} follow={follow} label={`Aperçu de l’avatar de ${name}`}
        sequence={sequenceMode && blocks.length ? { blocks, block, playing } : null} onBlockChange={setBlock} />
      <div className="space-y-3 text-sm">
        <div role="group" aria-label="Mode d’aperçu" className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" aria-pressed={!sequenceMode} onClick={() => { setSequenceMode(false); setPlaying(false); }}>États</Button>
          <Button type="button" size="sm" variant="outline" aria-pressed={sequenceMode} onClick={() => setSequenceMode(true)}>Séquence de démonstration</Button>
        </div>
        {sequenceMode ? <div role="group" aria-label="Lecture" className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={!blocks.length} onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Lecture"}</Button>
          <Button type="button" size="sm" variant="outline" disabled={!blocks.length} onClick={() => setBlock((block - 1 + blocks.length) % blocks.length)}>Bloc précédent</Button>
          <Button type="button" size="sm" variant="outline" disabled={!blocks.length} onClick={() => setBlock((block + 1) % blocks.length)}>Bloc suivant</Button>
        </div> : <p className="text-muted-foreground">Testez les états universels sans modifier l’état réel.</p>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Suivre le curseur</label>
        <Button type="button" size="sm" variant="outline" onClick={exportSvg}>Exporter l’image (SVG)</Button>
      </div>
    </div>

    {sequenceMode ? <section aria-label="Séquence" className="space-y-3">
      <ol className="space-y-1 text-sm">
        {blocks.map((item, i) => <li key={i} className={`flex flex-wrap items-center gap-2 rounded-lg border p-1.5 ${i === block ? "border-foreground" : ""}`}>
          <button type="button" className="min-w-28 text-left font-medium underline-offset-2 hover:underline" aria-current={i === block ? "step" : undefined} onClick={() => setBlock(i)}>{i + 1}. {ANIMATION_LABELS[item.state]}</button>
          <label className="flex items-center gap-1">Durée (s)
            <input type="number" className="w-16 rounded border bg-background px-1" min={minDurationOf(item.state)} max={MAX_BLOCK} step={STEP} value={item.duration}
              onChange={event => editBlocks(blocks.map((b, j) => j === i ? { ...b, duration: clampDuration(b.state, Number(event.target.value)) } : b))} /></label>
          <Button type="button" size="sm" variant="ghost" disabled={i === 0} aria-label={`Monter le bloc ${i + 1}`} onClick={() => editBlocks(blocks.map((b, j) => j === i - 1 ? blocks[i] : j === i ? blocks[i - 1] : b), i - 1)}>↑</Button>
          <Button type="button" size="sm" variant="ghost" disabled={i === blocks.length - 1} aria-label={`Descendre le bloc ${i + 1}`} onClick={() => editBlocks(blocks.map((b, j) => j === i + 1 ? blocks[i] : j === i ? blocks[i + 1] : b), i + 1)}>↓</Button>
          <Button type="button" size="sm" variant="ghost" aria-label={`Retirer le bloc ${i + 1}`} onClick={() => editBlocks(blocks.filter((_, j) => j !== i), i < block ? block - 1 : block)}>✕</Button>
        </li>)}
      </ol>
      <p className="text-sm text-muted-foreground">Durée totale : {totalDuration(blocks).toFixed(1)} s · <button type="button" className="underline" onClick={() => editBlocks(defaultCycle().blocks, 0)}>Séquence d’origine</button></p>
      <Group title="Ajouter une animation">
        {SEQUENCE.map((state: StateId) => <Tile key={state} label={ANIMATION_LABELS[state]} onClick={() => editBlocks([...blocks, makeBlock(state)], blocks.length)}>
          {thumb({ shape: value.shape, expression: value.expression, color: value.color, state, frozenAt: POSES[state] })}
        </Tile>)}
      </Group>
    </section> : <Group title="États universels">
      {BLOUB_ACTIVITIES.map(item => <Button key={item} type="button" size="sm" variant="outline" aria-pressed={activity === item} onClick={() => setActivity(item)}>{ACTIVITY_LABELS[item]}</Button>)}
    </Group>}

    <Group title="Forme">
      {SHAPES.map(shape => <Tile key={shape.id} label={SHAPE_LABELS[shape.id]} pressed={value.shape === shape.id} onClick={() => update({ shape: shape.id })}>
        {thumb({ shape: shape.id, expression: value.expression, color: value.color })}
      </Tile>)}
    </Group>
    <Group title="Expression">
      {EXPRESSIONS.map(expression => <Tile key={expression.id} label={EXPRESSION_LABELS[expression.id]} pressed={value.expression === expression.id} onClick={() => update({ expression: expression.id })}>
        {thumb({ shape: value.shape, expression: expression.id, color: value.color })}
      </Tile>)}
    </Group>
  </div>;
}
