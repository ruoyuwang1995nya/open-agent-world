import { useEffect, useRef, type RefObject } from 'react';
import { useReactFlow, useStoreApi, type Viewport } from '@xyflow/react';

export const MIN_CANVAS_ZOOM = 0.12;
export const MAX_CANVAS_ZOOM = 2.2;

// Match XYFlow's wheel normalization, including line/page wheels and Mac pinch.
export function wheelZoomTarget(zoom: number, event: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>, mac: boolean) {
  const unit = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002;
  return Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM,
    zoom * 2 ** (-event.deltaY * unit * (event.ctrlKey && mac ? 10 : 1))));
}

export function useSmoothWheelZoom(
  wrapper: RefObject<HTMLDivElement>,
  isScrollable: (target: EventTarget | null, boundary: HTMLElement) => boolean,
  onFinish: (viewport: Viewport) => void,
) {
  const { getViewport, setViewport } = useReactFlow();
  const store = useStoreApi();
  const writing = useRef(false);
  const finish = useRef(onFinish);
  finish.current = onFinish;

  useEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let pending: { from: Viewport; to: Viewport; applied: Viewport; start: number } | undefined;
    const same = (a: Viewport, b: Viewport) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.zoom - b.zoom) < 0.00001;
    const stop = () => {
      cancelAnimationFrame(frame);
      if (pending) { pending = undefined; finish.current(getViewport()); }
    };
    const apply = (viewport: Viewport) => {
      // Public XYFlow API updates nodes, hit testing and terrain together.
      // Its synchronous move-end callback must not persist every animation frame.
      writing.current = true;
      try { void setViewport(viewport); } finally { writing.current = false; }
    };
    const tick = (now: number) => {
      if (!pending) return;
      if (!same(getViewport(), pending.applied)) { stop(); return; }
      const progress = Math.min(1, (now - pending.start) / 180);
      const eased = 1 - (1 - progress) ** 3;
      const { from, to } = pending;
      const next = {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        zoom: from.zoom + (to.zoom - from.zoom) * eased,
      };
      apply(next);
      pending.applied = next;
      if (progress === 1) stop();
      else frame = requestAnimationFrame(tick);
    };
    const wheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const flow = target?.closest('.react-flow');
      if (event.defaultPrevented || flow?.id !== 'oaw-world-map' || !event.deltaY
        || target?.closest('.nowheel, [inert]') || store.getState().userSelectionActive) return;
      if (isScrollable(event.target, element)) { stop(); event.stopPropagation(); return; }
      event.preventDefault();
      event.stopPropagation();
      const current = getViewport();
      if (pending && !same(current, pending.applied)) stop();
      // Interrupt an in-flight fit/button transition before taking ownership.
      apply(current);
      const zoom = wheelZoomTarget(pending?.to.zoom ?? current.zoom, event, navigator.userAgent.includes('Mac'));
      const bounds = flow.getBoundingClientRect();
      const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
      const to = { zoom, x: x - (x - current.x) * zoom / current.zoom, y: y - (y - current.y) * zoom / current.zoom };
      cancelAnimationFrame(frame);
      if (media.matches) { pending = undefined; apply(to); finish.current(to); return; }
      pending = { from: current, to, applied: current, start: performance.now() };
      frame = requestAnimationFrame(tick);
    };
    element.addEventListener('wheel', wheel, { capture: true, passive: false });
    // Direct manipulation or another control takes ownership immediately.
    document.addEventListener('pointerdown', stop, true);
    document.addEventListener('keydown', stop, true);
    document.addEventListener('visibilitychange', stop);
    window.addEventListener('blur', stop);
    media.addEventListener('change', stop);
    return () => {
      stop();
      element.removeEventListener('wheel', wheel, true);
      document.removeEventListener('pointerdown', stop, true);
      document.removeEventListener('keydown', stop, true);
      document.removeEventListener('visibilitychange', stop);
      window.removeEventListener('blur', stop);
      media.removeEventListener('change', stop);
    };
  }, [wrapper, isScrollable, getViewport, setViewport, store]);
  return writing;
}
