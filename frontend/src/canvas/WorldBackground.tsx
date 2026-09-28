import { memo, useId, useLayoutEffect, useRef } from 'react';
import { useStoreApi } from '@xyflow/react';

const PADDING = 64;

/** Cached dot tiles scale with the camera; density changes crossfade at rest. */
export const WorldBackground = memo(function WorldBackground() {
  const store = useStoreApi();
  const id = `oaw-world-grid-${useId().replaceAll(':', '')}`;
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tiles = Array.from(root.current!.querySelectorAll('svg')).map(svg => ({
      svg, pattern: svg.querySelector('pattern')!, dot: svg.querySelector('circle')!, zoom: 0, stride: 1, padding: PADDING,
    }));
    let active = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const paint = (tile: typeof tiles[number], zoom: number, stride: number) => {
      const gap = 24 * stride * zoom;
      tile.pattern.setAttribute('width', String(gap));
      tile.pattern.setAttribute('height', String(gap));
      tile.pattern.setAttribute('patternTransform', `translate(${-gap / 2},${-gap / 2})`);
      tile.dot.setAttribute('cx', String(gap / 2));
      tile.dot.setAttribute('cy', String(gap / 2));
      // A long uninterrupted zoom can temporarily make dots farther apart than
      // the idle density. Keep a full cell of padding for either sign of pan.
      tile.padding = Math.max(PADDING, Math.ceil(gap));
      tile.svg.style.left = tile.svg.style.top = `${-tile.padding}px`;
      tile.svg.style.width = tile.svg.style.height = `calc(150% + ${tile.padding * 2}px)`;
      tile.pattern.setAttribute('x', String(tile.padding));
      tile.pattern.setAttribute('y', String(tile.padding));
      tile.zoom = zoom; tile.stride = stride;
    };
    const transform = () => {
      const [x, y, zoom] = store.getState().transform;
      for (const tile of tiles) {
        if (!tile.zoom) continue;
        const scale = zoom / tile.zoom;
        const gap = 24 * tile.stride * zoom;
        // Compensate padding around a top-left transform origin. Both densities
        // remain anchored to the same world coordinates during their crossfade.
        const offset = tile.padding * (1 - scale);
        tile.svg.style.transform = `translate(${x % gap + offset}px, ${y % gap + offset}px) scale(${scale})`;
      }
    };
    const settle = () => {
      timer = undefined;
      const zoom = store.getState().transform[2];
      const old = tiles[active];
      let stride = old.stride;
      // Hysteresis prevents tiny direction changes from toggling grid density.
      while (24 * stride * zoom < 16) stride *= 2;
      while (stride > 1 && 24 * stride * zoom > 40) stride /= 2;
      if (stride !== old.stride) {
        active = 1 - active;
        paint(tiles[active], zoom, stride);
        tiles[active].svg.style.opacity = '1';
        old.svg.style.opacity = '0';
      } else if (old.zoom !== zoom) paint(old, zoom, stride);
      transform();
    };
    const zoom = store.getState().transform[2];
    paint(tiles[0], zoom, 2 ** Math.max(0, Math.ceil(Math.log2(18 / (24 * zoom)))));
    transform();
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.transform === previous.transform) return;
      if (state.transform[2] !== previous.transform[2]) {
        const zoom = state.transform[2];
        // Only reraster at coarse scale boundaries, not on every animation frame.
        // The overscan covers zoom-out between these bounded refreshes.
        for (const tile of tiles) if (tile.zoom && (zoom / tile.zoom < 0.75 || zoom / tile.zoom > 1.5)) {
          paint(tile, zoom, tile.stride);
        }
        clearTimeout(timer);
        if (media.matches) settle();
        else timer = setTimeout(settle, 160);
      }
      transform();
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [store]);
  return <div ref={root} className="react-flow__background world-grid" data-testid="rf__background"
    aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
    {[0, 1].map(index => <svg key={index} className="world-grid-tile"
      style={{ position: 'absolute', left: -PADDING, top: -PADDING, width: `calc(150% + ${PADDING * 2}px)`,
        height: `calc(150% + ${PADDING * 2}px)`, transformOrigin: '0 0', willChange: 'transform, opacity', opacity: index === 0 ? 1 : 0 }}>
      <pattern id={`${id}-${index}`} x={PADDING} y={PADDING} patternUnits="userSpaceOnUse">
        <circle cx={0} cy={0} r={1} fill="var(--grid-dot)" />
      </pattern>
      <rect width="100%" height="100%" fill={`url(#${id}-${index})`} />
    </svg>)}
  </div>;
});
