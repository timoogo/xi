"use client";

import { useState } from "react";
import { toast } from "sonner";
import { createCorrection } from "@/lib/apis/corrections";
import { Button } from "@/components/ui/button";

export function CorrectionButton({ id }: { id: string }) {
  const [pending, setPending] = useState(false);
  return <Button size="sm" variant="outline" className="rounded-full" disabled={pending} onClick={async () => {
    setPending(true);
    try { const result = await createCorrection(id); toast.error(result.message); }
    finally { setPending(false); }
  }}>{pending ? "Création…" : "Créer une correction"}</Button>;
}
