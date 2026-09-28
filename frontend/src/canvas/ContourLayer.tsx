import { useStoreApi } from "@xyflow/react";
import { ViewportPortal } from "./FlowPortal";
import { lazy, memo, Suspense, useCallback, useLayoutEffect, useRef, useState } from "react";
import { CHUNK_SIZE, getViewportChunkBounds, getViewportChunkKeys } from "../state/chunks";
import { useWorldStore } from "../state/worldStore";
import type { FlowViewportState } from "../types/world";
import { TERRAIN_RESOLUTION, type TerrainChunkGeometry } from "./terrain";
import { useTerrainChunks } from './useTerrainChunks';

// Internal benchmark only. The production renderer remains SVG.
const CanvasExperiment = import.meta.env.DEV
  ? lazy(() => import('./TerrainCanvasExperiment')) : null;

interface TerrainView {
  keys: string[];
  signature: string;
}

function terrainViewSignature(viewport: FlowViewportState) {
  const { minX, maxX, minY, maxY } = getViewportChunkBounds(viewport, 0);
  return `${minX}:${maxX}:${minY}:${maxY}`;
}

function terrainViewFor(viewport: FlowViewportState): TerrainView {
  const visible = new Set(getViewportChunkKeys(viewport, 0));
  const keys = getViewportChunkKeys(viewport).sort((a, b) => Number(visible.has(b)) - Number(visible.has(a)));
  return { keys, signature: terrainViewSignature(viewport) };
}

// Worker arrivals and coverage changes should only render new/replaced tiles.
const ContourChunk = memo(function ContourChunk({ chunk }: { chunk: TerrainChunkGeometry }) {
  return <svg
    className="contour-chunk"
    data-chunk={`${chunk.chunkX}:${chunk.chunkY}`}
    data-resolution={chunk.resolution}
    viewBox={`0 0 ${CHUNK_SIZE} ${CHUNK_SIZE}`}
    style={{
      left: chunk.chunkX * CHUNK_SIZE,
      top: chunk.chunkY * CHUNK_SIZE,
    }}
    role="presentation"
  >
    {chunk.fillPaths.map((path, index) => path && (
      <path key={index} className="contour-fill" fillRule="evenodd" d={path} />
    ))}
    {chunk.minorPath && <path className="contour contour-minor" d={chunk.minorPath} />}
    {chunk.majorPath && <path className="contour contour-major" d={chunk.majorPath} />}
  </svg>;
});

export const ContourLayer = memo(function ContourLayer() {
  const store = useStoreApi();
  const layer = useRef<HTMLDivElement | null>(null);
  const attachLayer = useCallback((element: HTMLDivElement | null) => {
    layer.current = element;
    if (!element) return;
    // The owned portal can mount after our layout effect has already run.
    const zoom = store.getState().transform[2];
    element.style.setProperty('--contour-stroke-scale', String(1 / zoom));
    element.style.setProperty('--contour-promotion', zoom < 0.45 ? 'transform' : 'auto');
  }, [store]);
  const terrainSeed = useWorldStore((state) => state.terrainSeed);
  const [terrainView, setTerrainView] = useState(() => terrainViewFor(useWorldStore.getState().viewport));
  const currentView = useRef(terrainView);
  const retaining = useRef(false);
  const acceptViewport = useCallback((viewport: FlowViewportState, settled: boolean) => {
    // Constant-time boundary check on pointer moves; enumerate/sort only when
    // coverage changes, regardless of how wide the view is. Geometry stays at
    // the same resolution during motion, at rest, and when revisiting a tile.
    if (terrainViewSignature(viewport) === currentView.current.signature && (!settled || !retaining.current)) return;
    retaining.current = !settled;
    const next = terrainViewFor(viewport);
    if (!settled) {
      // Zooming in must not evict tiles that a wheel reversal needs again.
      // Bound retention during a long mixed pan/zoom gesture; visible keys win.
      const previous = currentView.current.keys;
      const retained = new Set(previous);
      if (next.keys.every(key => retained.has(key))) {
        currentView.current = { ...next, keys: previous };
        return;
      }
      next.keys = [...new Set([...next.keys, ...previous])].slice(0, Math.max(128, next.keys.length * 2));
    }
    currentView.current = next;
    setTerrainView(currentView.current);
  }, []);
  useLayoutEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let zooming = false;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const viewport = () => {
      const { transform: [x, y, zoom], width, height } = store.getState();
      return { x, y, zoom, width, height };
    };
    const settle = () => {
      timer = undefined;
      zooming = false;
      const view = viewport();
      const { zoom } = view;
      // Restore exact screen-space strokes only after the native transform rests.
      // Rewriting this inherited property per frame invalidates every SVG path.
      layer.current?.style.setProperty('--contour-stroke-scale', String(1 / zoom));
      layer.current?.style.setProperty('--contour-promotion', zoom < 0.45 ? 'transform' : 'auto');
      acceptViewport(view, true);
    };
    settle();
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.transform === previous.transform && state.width === previous.width && state.height === previous.height) return;
      if (state.transform[2] !== previous.transform[2]) {
        if (reduced.matches) { clearTimeout(timer); settle(); return; }
        if (!zooming) {
          zooming = true;
          // Keep overview tiles composited through a threshold crossing. Avoid
          // promoting huge world tiles at close zoom, where backing is expensive.
          layer.current?.style.setProperty('--contour-promotion', previous.transform[2] < 0.75 ? 'transform' : 'auto');
        }
        clearTimeout(timer);
        timer = setTimeout(settle, 160);
      }
      // New world coverage is still requested while moving; only stroke sizing waits.
      acceptViewport(viewport(), !zooming);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [store, acceptViewport]);

  const chunks = useTerrainChunks(terrainView.keys, TERRAIN_RESOLUTION, terrainSeed);
  const canvasExperiment = CanvasExperiment && new URLSearchParams(location.search).get('terrainRenderer') === 'canvas';

  return (
    <ViewportPortal>
      <div ref={attachLayer} className="contour-layer" data-terrain-renderer={canvasExperiment ? 'canvas-experiment' : 'svg'}>
        {chunks.map((chunk) => (
          <ContourChunk key={`${chunk.chunkX}:${chunk.chunkY}`} chunk={chunk} />
        ))}
        {canvasExperiment && <Suspense fallback={null}><CanvasExperiment chunks={chunks} /></Suspense>}
      </div>
    </ViewportPortal>
  );
});
