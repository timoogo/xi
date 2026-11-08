import type { PublicationCommand } from ".";

const HREF = "/dashboard/publications";

export const goToPublications = {
  id: "go-to",
  label: "Aller aux publications",
  // Hidden where it would do nothing.
  when: (_answers, { runtime }) => runtime.pathname !== HREF,
  run: (_answers, { runtime }) => runtime.navigate(HREF),
} satisfies PublicationCommand;
