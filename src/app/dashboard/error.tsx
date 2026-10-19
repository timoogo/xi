"use client";

import { Button } from "@/components/ui/button";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <section role="alert" className="px-6 py-16 text-center">
      <h2 className="text-2xl font-extrabold text-destructive">Une erreur est survenue</h2>
      <p className="mx-auto mt-2 max-w-md text-[15px] text-muted-foreground">{error.message}</p>
      <Button onClick={() => reset()} className="mt-6 rounded-full">Réessayer</Button>
    </section>
  );
}
