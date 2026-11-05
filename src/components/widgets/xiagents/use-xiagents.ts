"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { XiAgentCategory, XiAgentSummary } from "@/lib/xiagents/summary";

export const XIAGENTS_REFRESH_MS = 15_000;
type Lists = Record<XiAgentCategory, XiAgentSummary[] | null>;

async function request(url: string, init?: RequestInit): Promise<XiAgentSummary[]> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "ΞAgents indisponibles. Réessayez.");
  return data.agents;
}

/**
 * The ΞAgents of the selected category, refreshed periodically from the server (which computes the
 * activity). Each category keeps its own list: switching back shows it at once, then refreshes; a
 * category never loaded is fetched when selected. No request is made while the tab is hidden or the
 * widget is not rendered (e.g. a sidebar hidden on small screens); returning to the tab refreshes at
 * once. Pins are optimistic and the server's answer wins.
 */
export function useXiAgents(initial: Lists, category: XiAgentCategory, ref: RefObject<Element | null>) {
  const [lists, setLists] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // Bumped on each pin change: a poll started before it must not undo the optimistic state.
  const mutation = useRef(0);
  const loaded = useRef(lists);
  loaded.current = lists;
  const setList = (of: XiAgentCategory, next: XiAgentSummary[]) => setLists(current => ({ ...current, [of]: next }));

  const refresh = useCallback(async (of: XiAgentCategory) => {
    const seen = mutation.current;
    try {
      const next = await request(`/api/xiagents?category=${of}`);
      if (seen === mutation.current) { setList(of, next); setError(null); }
    } catch { setError("États non actualisés."); }
  }, []);

  useEffect(() => {
    let inFlight = false;
    const tick = () => {
      if (inFlight || document.hidden || ref.current?.checkVisibility?.() === false) return;
      inFlight = true;
      void refresh(category).finally(() => { inFlight = false; });
    };
    const onVisibility = () => { if (!document.hidden) tick(); };
    setError(null);
    if (loaded.current[category] === null) tick();
    const timer = setInterval(tick, XIAGENTS_REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [category, ref, refresh]);

  const togglePin = useCallback(async (agent: XiAgentSummary) => {
    const pinned = agent.pinnedAt === null;
    const id = ++mutation.current;
    const of = agent.category;
    setPending(set => new Set(set).add(agent.id));
    setLists(current => ({ ...current, [of]: current[of]?.map(item => item.id === agent.id ? { ...item, pinnedAt: pinned ? Date.now() : null } : item) ?? current[of] }));
    try {
      const next = await request(`/api/xiagents/${encodeURIComponent(agent.id)}/pin`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned }) });
      if (id === mutation.current) setList(of, next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Épingle non enregistrée.");
      if (id === mutation.current) await refresh(of);
    } finally {
      setPending(set => { const copy = new Set(set); copy.delete(agent.id); return copy; });
    }
  }, [refresh]);

  return { agents: lists[category], error, pending, togglePin };
}
