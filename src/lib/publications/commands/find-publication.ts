import type { PublicationCommand } from ".";
import type { PublicationSnapshot } from "../types";

const LABEL_LENGTH = 90;

/** The summary, else the first live message, as one short line. */
export function publicationLabel(publication: Pick<PublicationSnapshot, "summary" | "messages" | "status">) {
  const text = (publication.summary || publication.messages.find(message => !message.deleted && message.body.trim())?.body || "")
    .replace(/[#>*_`~]+/g, " ").replace(/\s+/g, " ").trim();
  const title = !text ? "Sans titre" : text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text;
  return publication.status === "draft" ? `Brouillon · ${title}` : title;
}

export const findPublication = {
  id: "find",
  label: "Rechercher une publication",
  progress: "local",
  steps: [
    { id: "scope", label: "Où chercher ?", options: [{ value: "own", label: "Mes publications et brouillons" }, { value: "feed", label: "Fil récent" }] },
    {
      id: "publication",
      label: "Publication",
      // First page only (the feed API's pagination); the palette filters it by label as the user types.
      options: async ({ scope }, { runtime }) => (await runtime.publications.list(scope === "own" ? "own" : "feed"))
        .map(publication => ({ value: publication.id, label: publicationLabel(publication) })),
    },
  ],
  run: ({ publication }, { runtime }) => runtime.navigate(`/dashboard/publications/${encodeURIComponent(publication)}`),
} satisfies PublicationCommand;
