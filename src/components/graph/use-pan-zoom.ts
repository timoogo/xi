"use client";

import { useEffect, useRef, type RefObject } from "react";
import { MAX_ZOOM, MIN_ZOOM, type Viewport } from "@/lib/graph/local-state";
import type { NodeId } from "@/lib/graph/types";
import type { Point } from "./layout";

export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Zoom by `factor` keeping the screen point `at` fixed. */
export function zoomAt(viewport: Viewport, factor: number, at: Point): Viewport {
  const k = clampZoom(viewport.k * factor);
  const ratio = k / viewport.k;
  return { k, x: at.x - (at.x - viewport.x) * ratio, y: at.y - (at.y - viewport.y) * ratio };
}

export const toWorld = (viewport: Viewport, point: Point): Point => ({ x: (point.x - viewport.x) / viewport.k, y: (point.y - viewport.y) / viewport.k });

const DRAG_THRESHOLD = 4;

type Gesture =
  | { kind: "idle" }
  | { kind: "press"; pointerId: number; start: Point; node: NodeId | null; origin: Viewport; grab: Point | null }
  | { kind: "pan"; pointerId: number; start: Point; origin: Viewport }
  | { kind: "drag"; pointerId: number; node: NodeId; grab: Point }
  | { kind: "pinch"; distance: number; center: Point; origin: Viewport };

/**
 * Wheel zoom, background pan, two-finger pinch and (free mode) node drag on an SVG element. Pointer capture is
 * only taken once a gesture moves past a few pixels, so a plain click still reaches the node under the pointer.
 */
export function usePanZoom({ svgRef, viewport, onViewport, nodeDrag, onNodeDrag }: {
  svgRef: RefObject<SVGSVGElement | null>;
  viewport: Viewport;
  onViewport: (viewport: Viewport) => void;
  nodeDrag: boolean;
  onNodeDrag: (id: NodeId, world: Point, done: boolean) => void;
}) {
  const latest = useRef({ viewport, onViewport, nodeDrag, onNodeDrag });
  useEffect(() => {
    latest.current = { viewport, onViewport, nodeDrag, onNodeDrag };
  });
  const suppressClick = useRef(false);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const pointers = new Map<number, Point>();
    let gesture: Gesture = { kind: "idle" };
    const local = (event: { clientX: number; clientY: number }): Point => {
      const rect = svg.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const pinchState = (): { distance: number; center: Point } => {
      const [a, b] = [...pointers.values()];
      return { distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const { viewport: current, onViewport: set } = latest.current;
      set(zoomAt(current, Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)), local(event)));
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      const point = local(event);
      pointers.set(event.pointerId, point);
      suppressClick.current = false;
      if (pointers.size === 2) {
        gesture = { kind: "pinch", ...pinchState(), origin: latest.current.viewport };
        for (const id of pointers.keys()) if (!svg.hasPointerCapture(id)) try { svg.setPointerCapture(id); } catch { /* pointer already gone */ }
        return;
      }
      if (pointers.size > 2) return;
      const target = (event.target as Element | null)?.closest?.("[data-node-id]");
      const interactive = (event.target as Element | null)?.closest?.("[data-graph-control]");
      if (interactive) return;
      const node = target?.getAttribute("data-node-id") ?? null;
      const world = toWorld(latest.current.viewport, point);
      gesture = { kind: "press", pointerId: event.pointerId, start: point, node, origin: latest.current.viewport, grab: node ? world : null };
    };

    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      const point = local(event);
      pointers.set(event.pointerId, point);
      const { onViewport: set, nodeDrag, onNodeDrag: drag } = latest.current;
      if (gesture.kind === "pinch" && pointers.size >= 2) {
        const { distance, center } = pinchState();
        const scaled = zoomAt(gesture.origin, distance / gesture.distance, gesture.center);
        set({ ...scaled, x: scaled.x + center.x - gesture.center.x, y: scaled.y + center.y - gesture.center.y });
        return;
      }
      if (gesture.kind === "press" && gesture.pointerId === event.pointerId) {
        if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) < DRAG_THRESHOLD) return;
        try { svg.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        suppressClick.current = true;
        gesture = gesture.node && nodeDrag
          ? { kind: "drag", pointerId: event.pointerId, node: gesture.node, grab: gesture.grab! }
          : { kind: "pan", pointerId: event.pointerId, start: gesture.start, origin: gesture.origin };
      }
      if (gesture.kind === "pan" && gesture.pointerId === event.pointerId) {
        set({ ...gesture.origin, x: gesture.origin.x + point.x - gesture.start.x, y: gesture.origin.y + point.y - gesture.start.y });
      } else if (gesture.kind === "drag" && gesture.pointerId === event.pointerId) {
        drag(gesture.node, toWorld(latest.current.viewport, point), false);
      }
    };

    const onUp = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
      if (gesture.kind === "drag" && gesture.pointerId === event.pointerId) latest.current.onNodeDrag(gesture.node, toWorld(latest.current.viewport, local(event)), true);
      if (gesture.kind === "pinch") {
        // Continue panning with the remaining finger.
        const [rest] = [...pointers.entries()];
        gesture = rest ? { kind: "pan", pointerId: rest[0], start: rest[1], origin: latest.current.viewport } : { kind: "idle" };
        return;
      }
      if (pointers.size === 0) gesture = { kind: "idle" };
    };

    // A click right after a drag or a pan must not toggle the node under the pointer.
    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.stopPropagation();
      event.preventDefault();
    };

    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("click", onClickCapture, true);
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("pointerdown", onDown);
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointercancel", onUp);
      svg.removeEventListener("click", onClickCapture, true);
    };
  }, [svgRef]);
}
