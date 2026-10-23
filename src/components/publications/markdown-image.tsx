"use client";

import Image from "next/image";
import { useState } from "react";

/** Remote media stays opt-in: no third-party request while reading the feed. */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const safe = src && /^https:\/\//i.test(src);
  if (!safe) return <span className="xi-wikilink">{alt ? `[image: ${alt}]` : "[image]"}</span>;
  return <span className="relative my-3 flex aspect-video w-full items-center justify-center overflow-hidden rounded-2xl border bg-muted">
    {loaded && !failed ? <Image src={src} alt={alt ?? ""} fill unoptimized referrerPolicy="no-referrer" className="object-contain" onError={() => setFailed(true)} /> :
      <button type="button" className="min-h-11 max-w-full rounded-lg p-3 text-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setFailed(false); setLoaded(true); }}>
        {failed ? "Image indisponible · Réessayer" : `Afficher l’image${alt ? ` : ${alt}` : ""}`}<span className="block text-xs">Charge un contenu externe</span>
      </button>}
  </span>;
}
