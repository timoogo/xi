"use client";

import { ArrowDown, ArrowUp, BookPlus, Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { addPublicationSource, publishPublication, savePublication } from "@/lib/apis/publications";
import { rewriteFolderLinks } from "@/lib/publications/links";
import type { SourceFormInput } from "@/lib/publications/store";
import { VISIBILITIES, type PublicationSnapshot, type Visibility } from "@/lib/publications/types";
import { PublicationBadges, VISIBILITY_LABELS } from "./publication-badges";
import { TrashButton } from "./publication-actions";
import { PublicationContent } from "./publication-content";
import { RawMarkdownField, VisualMarkdownField } from "./markdown-field";
import { SourceForm } from "./source-form";

type Message = { key: string; file: string | null; body: string };
type Draft = { summary: string; messages: Message[]; visibility: Visibility };
type Mode = "visual" | "markdown" | "preview";
type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

const AUTOSAVE_DELAY = 1500;
const NEW_MESSAGE = "\n\n## Sources\n";
const MODES: { id: Mode; label: string }[] = [{ id: "visual", label: "Visuel" }, { id: "markdown", label: "Markdown" }, { id: "preview", label: "Aperçu" }];
const STATE_LABELS: Record<SaveState, string> = {
  saved: "Modifications enregistrées dans le vault", dirty: "Modifications non enregistrées", saving: "Enregistrement…",
  conflict: "Non enregistré : conflit avec les fichiers", error: "Non enregistré",
};

const fromSnapshot = (snapshot: PublicationSnapshot): Draft => ({
  summary: snapshot.summary, visibility: snapshot.visibility,
  messages: snapshot.messages.map((message) => ({ key: message.file, file: message.file, body: message.body })),
});

function appendSourceLine(body: string, line: string) {
  if (/^##\s+Sources\s*$/im.test(body)) return `${body.replace(/\s*$/, "")}\n${line}\n`;
  return `${body.replace(/\s*$/, "")}\n\n## Sources\n${line}\n`;
}

export function PublicationEditor({ initial }: { initial: PublicationSnapshot }) {
  const router = useRouter();
  const id = initial.id;
  const [draft, setDraft] = useState<Draft>(() => fromSnapshot(initial));
  const [status, setStatus] = useState(initial.status);
  const [type, setType] = useState(initial.type);
  const [sources, setSources] = useState(initial.sources);
  const [mode, setMode] = useState<Mode>("visual");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<PublicationSnapshot | null>(null);
  const [sourceFor, setSourceFor] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const activeProps = (key: string) => ({ editing: active === key, onEditingChange: (editing: boolean) => setActive(editing ? key : null) });
  const [busy, setBusy] = useState(false);

  // Refs give queued server calls the latest values without re-creating them on each keystroke.
  const latest = useRef(draft);
  const revision = useRef(initial.revision);
  const version = useRef(0);
  const blocked = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => { latest.current = draft; }, [draft]);

  const enqueue = useCallback(<T,>(task: () => Promise<T>) => {
    const run = queue.current.then(task);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  function edit(update: (draft: Draft) => Draft) {
    version.current++;
    setDraft((current) => update(current));
    setSaveState((state) => state === "conflict" ? state : "dirty");
  }

  function showConflict(snapshot: PublicationSnapshot) {
    blocked.current = true;
    setConflict(snapshot);
    setSaveState("conflict");
  }

  const save = useCallback(() => enqueue(async () => {
    if (blocked.current) return false;
    const sent = latest.current;
    const sentVersion = version.current;
    setSaveState("saving");
    try {
      const result = await savePublication(id, { baseRevision: revision.current, ...sent });
      if ("message" in result) {
        setError(result.message);
        setSaveState("error");
        return false;
      }
      if (!result.ok) {
        showConflict(result.conflict);
        return false;
      }
      revision.current = result.snapshot.revision;
      setType(result.snapshot.type);
      setSources(result.snapshot.sources);
      const relocated = result.relocated;
      const fix = (text: string) => relocated ? rewriteFolderLinks(text, relocated.from, relocated.to) : text;
      setDraft((current) => ({
        ...current, summary: fix(current.summary),
        messages: current.messages.map((message) => ({ ...message, file: message.file ?? result.files[message.key] ?? null, body: fix(message.body) })),
      }));
      setError(undefined);
      setSaveState(version.current === sentVersion ? "saved" : "dirty");
      return true;
    } catch {
      setError("Connexion perdue. Votre texte est conservé ; l’enregistrement sera retenté.");
      setSaveState("error");
      return false;
    }
  }), [enqueue, id]);

  // Drafts autosave into the Markdown files; published publications change only on an explicit save.
  useEffect(() => {
    if (status !== "draft" || saveState !== "dirty") return;
    const timer = setTimeout(() => void save(), AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [draft, status, saveState, save]);

  useEffect(() => {
    if (status !== "draft" || saveState !== "error") return;
    const timer = setTimeout(() => void save(), 10_000);
    return () => clearTimeout(timer);
  }, [status, saveState, save]);

  useEffect(() => {
    if (saveState === "saved") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  function loadFileVersion() {
    if (!conflict) return;
    blocked.current = false;
    revision.current = conflict.revision;
    version.current++;
    setDraft(fromSnapshot(conflict));
    setStatus(conflict.status);
    setType(conflict.type);
    setSources(conflict.sources);
    setConflict(null);
    setSaveState("saved");
  }

  function keepMine() {
    if (!conflict) return;
    blocked.current = false;
    revision.current = conflict.revision;
    setStatus(conflict.status);
    setConflict(null);
    setSaveState("dirty");
    void save();
  }

  async function publish() {
    setBusy(true);
    if (saveState !== "saved" && !(await save())) return setBusy(false);
    const result = await enqueue(() => publishPublication(id, revision.current));
    setBusy(false);
    if ("message" in result) return void toast.error(result.message);
    if (!result.ok) return showConflict(result.conflict);
    toast.success("Publié.");
    setStatus("published");
    router.push(`/dashboard/publications/${id}`);
  }

  /** Flush pending edits into the files, then stop autosave: the folder is about to move to the trash. */
  async function beforeTrash() {
    if (saveState !== "saved" && saveState !== "conflict") await save();
    blocked.current = true;
    await queue.current;
    setSaveState("saved");
  }

  async function addSource(messageKey: string, source: SourceFormInput) {
    const result = await enqueue(() => addPublicationSource(id, revision.current, source));
    if ("message" in result) {
      toast.error(result.message);
      return false;
    }
    if (!result.ok) {
      showConflict(result.conflict);
      return false;
    }
    revision.current = result.revision;
    setSources(result.snapshot.sources);
    edit((current) => ({ ...current, messages: current.messages.map((message) => message.key === messageKey ? { ...message, body: appendSourceLine(message.body, result.line) } : message) }));
    return true;
  }

  const setMessage = (key: string, body: string) => edit((current) => ({ ...current, messages: current.messages.map((message) => message.key === key ? { ...message, body } : message) }));
  const move = (index: number, offset: number) => edit((current) => {
    const messages = [...current.messages];
    [messages[index], messages[index + offset]] = [messages[index + offset], messages[index]];
    return { ...current, messages };
  });
  const remove = (key: string) => edit((current) => ({ ...current, messages: current.messages.filter((message) => message.key !== key) }));
  const addMessage = () => {
    const key = crypto.randomUUID();
    edit((current) => ({ ...current, messages: [...current.messages, { key, file: null, body: NEW_MESSAGE }] }));
    setActive(key);
  };

  const Field = mode === "markdown" ? RawMarkdownField : VisualMarkdownField;

  return (
    <div className="space-y-4 pb-4">
      <header className="sticky top-0 z-20 space-y-3 border-b bg-background/85 px-4 py-3 backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold">{status === "draft" ? "Modifier le brouillon" : "Modifier la publication"}</h1>
            <PublicationBadges status={status} visibility={draft.visibility} type={type} />
          </div>
          <p aria-live="polite" className={`text-xs ${saveState === "conflict" || saveState === "error" ? "text-destructive" : "text-muted-foreground"}`}>{STATE_LABELS[saveState]}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="Mode de l’éditeur" className="inline-flex rounded-full border p-0.5">
            {MODES.map((item) => (
              <button key={item.id} role="tab" type="button" aria-selected={mode === item.id} onClick={() => setMode(item.id)}
                className={`rounded-full px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${mode === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Visibilité</span>
              <select value={draft.visibility} onChange={(event) => edit((current) => ({ ...current, visibility: event.target.value as Visibility }))}
                className="h-8 rounded-full border bg-background px-3 text-sm">
                {VISIBILITIES.map((value) => <option key={value} value={value}>{VISIBILITY_LABELS[value]}</option>)}
              </select>
            </label>
            {status === "draft"
              ? <Button size="sm" className="rounded-full px-4 font-bold" onClick={publish} disabled={busy || saveState === "conflict"}>Publier</Button>
              : <Button size="sm" onClick={() => void save()} disabled={busy || saveState === "saved" || saveState === "saving" || saveState === "conflict"} className="rounded-full px-4 font-bold">Enregistrer</Button>}
            {status === "published" ? <Button size="sm" variant="outline" className="rounded-full" asChild><Link href={`/dashboard/publications/${id}`}>Voir</Link></Button> : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {status === "draft" ? "Un brouillon n’est visible que par vous, quelle que soit sa visibilité." : null}
          {draft.visibility === "followers" ? " Les publications réservées aux abonnés restent visibles par vous uniquement tant que les abonnements n’existent pas." : null}
        </p>
      </header>

      {conflict ? (
        <div role="alert" className="mx-4 space-y-3 rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">Cette publication a été modifiée hors de Ξ (par exemple dans Obsidian). Rien n’a été écrasé.</p>
          <p className="text-muted-foreground">Votre version est toujours dans l’éditeur. Chargez la version des fichiers (vos modifications non enregistrées sont abandonnées), ou conservez la vôtre et remplacez les fichiers.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={loadFileVersion}>Charger la version des fichiers</Button>
            <Button size="sm" variant="destructive" onClick={keepMine}>Conserver ma version</Button>
          </div>
        </div>
      ) : null}
      {error && saveState === "error" ? <p role="alert" className="px-4 text-sm text-destructive">{error}</p> : null}

      {mode === "preview" ? (
        <section aria-label="Aperçu" className="mx-4 rounded-2xl border p-4 text-[15px] leading-6">
          <PublicationContent summary={draft.summary} messages={draft.messages} sources={sources} />
        </section>
      ) : (
        <>
          <section aria-label="Résumé" className="mx-4 rounded-2xl border p-3">
            <Field label={mode === "markdown" ? "index.md — résumé (frontmatter et embeds gérés par Ξ)" : "Résumé"}
              value={draft.summary} placeholder="Résumé de la publication…" {...activeProps("summary")} onChange={(summary) => edit((current) => ({ ...current, summary }))} />
          </section>
          <ol aria-label="Messages" className="mx-4 space-y-3">
            {draft.messages.map((message, index) => (
              <li key={message.key} className="rounded-2xl border p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-muted-foreground">Message {index + 1}{message.file ? null : " · nouveau, enregistré dès qu’il est écrit"}</p>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" className="size-8" aria-label={`Monter le message ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
                    <Button size="icon" variant="ghost" className="size-8" aria-label={`Descendre le message ${index + 1}`} disabled={index === draft.messages.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
                    <Button size="icon" variant="ghost" className="size-8" aria-label={`Ajouter une note source au message ${index + 1}`} onClick={() => setSourceFor(sourceFor === message.key ? null : message.key)}><BookPlus /></Button>
                    <Button size="icon" variant="ghost" className="size-8 text-destructive" aria-label={`Retirer le message ${index + 1}`} onClick={() => remove(message.key)}><X /></Button>
                  </div>
                </div>
                <Field label={mode === "markdown" ? (message.file ?? "nouveau message") : `Message ${index + 1}`} value={message.body}
                  placeholder="Écrivez ce message…" {...activeProps(message.key)} onChange={(body) => setMessage(message.key, body)} />
                {sourceFor === message.key ? <SourceForm onSubmit={(source) => addSource(message.key, source)} onCancel={() => setSourceFor(null)} /> : null}
              </li>
            ))}
          </ol>
          <div className="mx-4 space-y-2">
            <Button variant="outline" className="rounded-full" onClick={addMessage}><Plus />Ajouter un message</Button>
            <p className="text-xs text-muted-foreground">Les messages retirés sont déplacés dans votre corbeille privée, jamais supprimés.</p>
          </div>
        </>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t px-4 pt-4">
        <TrashButton id={id} redirectTo="/dashboard/publications" beforeTrash={beforeTrash} />
      </footer>
    </div>
  );
}
