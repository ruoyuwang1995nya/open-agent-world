// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { TerrainChunkGeometry } from './terrain';
import { ContourLayer } from './ContourLayer';

type FlowState = { transform: number[]; width: number; height: number };
const fixture = vi.hoisted(() => ({
  state: { transform: [0, 0, 0.3], width: 1600, height: 900 },
  listeners: new Set<(state: FlowState, previous: FlowState) => void>(),
  geometry: [{ key: '123:0:0:56', chunkX: 0, chunkY: 0, resolution: 56, minorPath: 'M0 0L100 100', majorPath: '', fillPaths: [] }],
  chunks: vi.fn((_keys: string[], _resolution: number, _seed: number | null): TerrainChunkGeometry[] => []),
}));
const store = { getState: () => fixture.state, subscribe: (fn: (state: FlowState, previous: FlowState) => void) => {
  fixture.listeners.add(fn); return () => fixture.listeners.delete(fn);
} };
vi.mock('@xyflow/react', () => ({ useStoreApi: () => store }));
vi.mock('./FlowPortal', () => ({ ViewportPortal: ({ children }: { children: ReactNode }) => children }));
vi.mock('./useTerrainChunks', () => ({ useTerrainChunks: (keys: string[], resolution: number, seed: number | null) => fixture.chunks(keys, resolution, seed) }));
vi.mock('../state/worldStore', () => {
  const state = { viewport: { x: 0, y: 0, zoom: 0.3, width: 1600, height: 900 }, terrainSeed: 123 };
  return { useWorldStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
function zoom(value: number) {
  const previous = fixture.state;
  fixture.state = { ...previous, transform: [0, 0, value] };
  fixture.listeners.forEach(fn => fn(fixture.state, previous));
}
beforeEach(() => {
  vi.useFakeTimers(); fixture.chunks.mockClear();
  fixture.chunks.mockReturnValue(fixture.geometry);
  fixture.state = { transform: [0, 0, 0.3], width: 1600, height: 900 };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps medium-detail geometry through zoom and rest, restoring only stroke width', () => {
  const { container, unmount } = render(<ContourLayer />);
  const layer = container.querySelector<HTMLElement>('.contour-layer')!;
  expect(Number(layer.style.getPropertyValue('--contour-stroke-scale'))).toBeCloseTo(1 / 0.3);
  act(() => zoom(0.6));
  act(() => { vi.advanceTimersByTime(150); zoom(0.8); });
  expect(Number(layer.style.getPropertyValue('--contour-stroke-scale'))).toBeCloseTo(1 / 0.3);
  expect(fixture.chunks.mock.lastCall?.[1]).toBe(56);
  act(() => vi.advanceTimersByTime(160));
  expect(Number(layer.style.getPropertyValue('--contour-stroke-scale'))).toBeCloseTo(1 / 0.8);
  expect(fixture.chunks.mock.lastCall?.[1]).toBe(56);
  for (const value of [0.12, 0.45, 1.2, 2.2, 0.3]) {
    act(() => zoom(value));
    act(() => vi.advanceTimersByTime(160));
    expect(fixture.chunks.mock.lastCall?.[1]).toBe(56);
  }
  expect(fixture.chunks.mock.calls.every(call => call[1] === 56)).toBe(true);
  act(() => zoom(1.4));
  unmount();
  expect(fixture.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains cached coverage for a reversal but trims it after a zoom-in settles', () => {
  render(<ContourLayer />);
  const initial = fixture.chunks.mock.lastCall?.[0];
  act(() => zoom(0.4));
  expect(fixture.chunks.mock.lastCall?.[0]).toBe(initial);
  act(() => zoom(0.3));
  expect(fixture.chunks.mock.lastCall?.[0]).toBe(initial);
  act(() => zoom(0.4));
  act(() => vi.advanceTimersByTime(160));
  expect(fixture.chunks.mock.lastCall![0].length).toBeLessThan(initial!.length);
});

it('keeps tile identity and skips React renders within unchanged coverage, then requests a new pan boundary', () => {
  const { container } = render(<ContourLayer />);
  const tile = container.querySelector('svg.contour-chunk');
  const initial = fixture.chunks.mock.calls.length;
  for (let i = 0; i < 20; i++) act(() => zoom(0.3 + i * 0.001));
  expect(fixture.chunks.mock.calls).toHaveLength(initial);
  expect(container.querySelector('svg.contour-chunk')).toBe(tile);
  act(() => vi.advanceTimersByTime(160));
  expect(Number(container.querySelector<HTMLElement>('.contour-layer')!.style.getPropertyValue('--contour-stroke-scale'))).toBeCloseTo(1 / 0.319);
  act(() => {
    const previous = fixture.state;
    fixture.state = { ...previous, transform: [-2100, 0, 0.319] };
    fixture.listeners.forEach(fn => fn(fixture.state, previous));
  });
  expect(fixture.chunks.mock.calls.length).toBeGreaterThan(initial);
  expect(fixture.chunks.mock.lastCall![0]).toContain('5:0');
});
