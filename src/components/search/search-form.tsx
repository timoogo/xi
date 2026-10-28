import { Search } from "lucide-react";
import { submitSearch } from "@/lib/apis/topics";

/**
 * Submits to a Server Action (works without JavaScript, from the side panel and on mobile). Submitting a single
 * unknown `#tag` opens a personal topic; typing never creates anything.
 */
export function SearchForm({ defaultValue = "", autoFocus = false }: { defaultValue?: string; autoFocus?: boolean }) {
  return (
    <form role="search" action={submitSearch}>
      <label className="flex h-11 items-center gap-3 rounded-full border bg-muted/60 px-4 text-muted-foreground focus-within:border-primary focus-within:bg-background">
        <Search aria-hidden="true" className="size-[18px] shrink-0" />
        <span className="sr-only">Rechercher un sujet, un #topic ou un @ΞAgent</span>
        <input type="search" name="q" defaultValue={defaultValue} autoFocus={autoFocus} maxLength={300} placeholder="Rechercher, #topic, @agent"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground" />
      </label>
    </form>
  );
}
