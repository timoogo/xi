"use client";

import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { XIAGENT_CATEGORIES, XIAGENT_CATEGORY_LABELS, xiAgentsHref, type XiAgentCategory } from "@/lib/xiagents/summary";

const items = XIAGENT_CATEGORIES.map(value => ({ value, label: XIAGENT_CATEGORY_LABELS[value] }));

/** « Agents éditoriaux / Agents systèmes » (shadcn/ui Base Select). */
export function XiAgentCategorySelect({ value, onValueChange, size = "default", className }: { value: XiAgentCategory; onValueChange: (value: XiAgentCategory) => void; size?: "sm" | "default"; className?: string }) {
  return <Select items={items} value={value} onValueChange={next => { if (next) onValueChange(next as XiAgentCategory); }}>
    <SelectTrigger size={size} aria-label="Catégorie de ΞAgents" className={className}><SelectValue /></SelectTrigger>
    <SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
  </Select>;
}

/** The page's selector: the category lives in the URL (`?category=`), so it survives reloads and history. */
export function XiAgentCategoryNav({ value }: { value: XiAgentCategory }) {
  const router = useRouter();
  return <XiAgentCategorySelect value={value} onValueChange={next => { if (next !== value) router.push(xiAgentsHref(next)); }} />;
}
