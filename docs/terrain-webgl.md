# WebGL2 terrain background

The world background uses one native WebGL2 canvas under React Flow. The legacy
SVG renderer, its path cache and the Canvas2D experiment have been removed. Cards,
edges, selection, hit testing, wheel normalization and viewport persistence remain
owned by React Flow and the existing canvas controllers. No new runtime dependency
is required.

## Rendering and resource ownership

`TerrainBackground` mounts the renderer and subscribes directly to the React Flow
camera store. Camera updates schedule one animation frame; they do not set React
state or write background DOM styles. `TerrainRendererWebGL` draws a procedural
world-anchored dot grid, then the visible terrain tile quads.

The terrain worker only returns scalar tiles, sampling the original seeded field
without marching squares or SVG path construction. Each 2048-world-unit tile
retains the existing resolution of 56 cells and adds a one-sample halo:
a 59 x 59 `Float32Array`. The worker
transfers a copy while retaining its bounded cache. Adjacent halos sample the same
world coordinates, including negative coordinates.

Each tile becomes one `R32F` texture. The fragment shader interpolates the field,
fills elevation bands and computes contour coverage from screen derivatives.
Contour widths remain 1.15 / 1.65 CSS pixels throughout a zoom gesture, including
DPR compensation. Colors and opacity use the existing theme tokens. The accepted
WebGL visual style is retained; it does not reproduce every smoothed SVG path.
Grid density changes continuously between nested world-coordinate dot lattices.

Panning and zooming only update camera/draw uniforms for resident tiles. Crossing
coverage boundaries requests missing tiles, visible first, with a one-tile prefetch
ring. Obsolete worker replies are ignored. Tile data is uploaded only on first
arrival, seed changes, after eviction/revisit, or context restoration. Large world
coordinates are rebased before passing float uniforms to the GPU.

Both the worker scalar cache and GPU texture cache are bounded to 256 tiles. The
GPU cache also has a 4 MiB byte budget and deletes evicted textures. At resolution
56, 256 textures contain **3,564,544 bytes (3.40 MiB)**. The main thread retains
bounded CPU recovery copies of those same samples. The canvas backing store is
separately capped at 16,777,216 pixels and the device's maximum dimensions. Browser
swap-chain/driver allocations are additional to these application-owned budgets.

Resize and DPR notifications update backing dimensions only when necessary. Theme
changes only update color uniforms. On context loss the canvas is hidden, revealing
only the shell's theme background color. Restoration recreates programs and
reuploads the retained bounded tiles, then displays the canvas again. Permanent
initialization/worker/upload failure, or a viewport exceeding the 256-visible-tile
budget, also leaves the theme background visible; cards and canvas interaction
remain available. There is no secondary terrain renderer to mount or rasterize.

## Diagnostics

Renderer selection by URL or `VITE_TERRAIN_RENDERER` has been removed. Old
`terrainRenderer` query parameters are ignored. The canvas exposes
`data-terrain-status` (`loading`, `ready`, `context-lost`, `unavailable`) and
`data-terrain-error` on failures. No ordinary user-facing configuration is needed.

Read `document.querySelector('.terrain-webgl-background').terrainStats` in DevTools
for tile counts, bytes, uploads, evictions, coverage, draws and context restores.
This getter does not mutate the DOM or update React during gestures.

## Reproduction

From `frontend`, run:

```powershell
node scripts/benchmark-terrain-webgl.mjs
node scripts/benchmark-terrain-webgl.mjs --scenes near,wide --trace
node scripts/benchmark-terrain-webgl.mjs --scenes long --memory
$env:PLAYWRIGHT_CHANNEL='msedge'
node scripts/run-e2e.mjs e2e/terrain-webgl.spec.ts
```

The benchmark starts an isolated backend on 8028 and frontend on 5188, retains
its data and reports under `.outputs/terrain-webgl-<timestamp>`, and never changes
the user's world. Ports and browser channel are configurable. It uses the same
1600 x 1000 viewport, pan trajectory and wheel sequence as the original empty
canvas investigation. It now runs WebGL-only repetitions. Separate trace runs
record raster activity; traced timing is not mixed into ordinary frame timings.

Scenes include near and wide zoom, DPR 2, dark theme, 48 real text cards, and
continuous travel through hundreds of tiles with zoom and reversal. Runtime event
streams are held fixed during measurement. Frame intervals are `requestAnimationFrame`
observations, not measured display presentation times. GPU process CPU is reported
as a percentage of one CPU core, not hardware GPU utilization.

The focused Playwright tests also cover card dragging/persistence, cursor-anchored
zoom, texture reuse, live theme/seed changes, resize, DPR, cache eviction, forced
context loss/restoration, procedural grid anchoring, and interaction without WebGL2. CDP's DPR
override does not emit a monitor-change event in headless Edge, so that test
explicitly dispatches resize after changing DPR.

## Historical SVG / WebGL measurements (2026-09-29)

These paired measurements were captured before removing SVG. Reports are retained
below; reproducing the SVG side requires the earlier renderer revision.

Standalone headless Edge 153.0.4234.32, Windows, i7-14700F, RTX 4060 Ti / ANGLE
D3D11, CPU throttle 1. These are local comparisons, not universal FPS claims.
The table shows both reverse-order rounds where applicable.

| Scene / metric | SVG | WebGL2 |
| --- | --- | --- |
| Near zoom p95 | 33.4 / 33.4 ms | 16.8 / 16.8 ms |
| Near zoom GPU process CPU | 103.7 / 104.6% | 13.7 / 13.5% |
| Near pan p95 | 16.8 / 16.8 ms | 16.8 / 16.8 ms |
| Near pan GPU process CPU | 84.7 / 87.6% | 11.2 / 9.1% |
| Wide zoom maximum interval | 233.3 / 233.4 ms | 16.9 / 16.8 ms |
| Wide zoom intervals >34 ms | 4 / 3 | 0 / 0 |
| DPR 2 near zoom p95 | 33.4 / 33.4 ms | 16.8 / 16.8 ms |
| Dark near zoom p95 | 33.4 / 33.4 ms | 16.8 / 16.8 ms |
| 48 cards pan p95 | 50.0 / 50.0 ms | 16.8 / 16.8 ms |
| 48 cards zoom p95 | 66.7 / 50.1 ms | 33.4 / 33.4 ms |
| Continuous pan/zoom maximum interval | 233.3 ms | 16.9 ms |
| Continuous pan/zoom intervals >34 ms | 65 | 0 |

The continuous sequence takes 44.8 seconds with SVG and 37.8 seconds with WebGL2
because the driver awaits input delivery. Both use the same 48 pan passes and
wheel sequences; delivery timing means their continuous camera trajectories are
not frame-for-frame identical. The primary near/wide paired gestures finish at
matching camera transforms. WebGL2 reaches 256 resident textures / 3.40 MiB, then stays there:
518 uploads, 262 evictions, and complete final viewport coverage. No page errors
were recorded in any of the 22 A/B runs.

Cards still incur their own rendering costs. In the 48-card zoom case, WebGL2
renders more frames and GPU process CPU is approximately 127%, versus 116–117%
for SVG. This change removes the background bottleneck; it does not eliminate
card rasterization or optimize the separate card rendering architecture.

Raw A/B report and screenshots:
[`terrain-webgl-1790646741826`](../.outputs/terrain-webgl-1790646741826/report.json).

Separate Chromium traces confirm that the large SVG raster workload is removed:

| Pan + zoom trace | SVG `DoRasterCHROMIUM` | WebGL2 `DoRasterCHROMIUM` |
| --- | --- | --- |
| Near | 5,082 calls / 5,311 ms | 310 calls / 59.8 ms |
| Wide | 1,376 calls / 968 ms | 309 calls / 55.4 ms |

These are summed outer `CrGpuMain/RasterDecoderImpl::DoRasterCHROMIUM` durations;
the nested `Deserializing` events are not added again. Background SVG nodes are
absent in WebGL2 runs, while the surrounding HUD/React Flow UI remains. Residual
raster work is small and similar at near and wide zoom; this is not a claim that
Chromium performs zero raster work anywhere in the page.
Trace files and summaries:
[`terrain-webgl-1790647172673`](../.outputs/terrain-webgl-1790647172673/report.json).

A separate Windows GPU Process Memory counter run sampled the benchmark's GPU
process every five seconds during continuous travel. After the 256-tile cache
filled, dedicated usage stayed between **51.65 and 54.19 MiB**, and shared usage
between **5.52 and 6.52 MiB**; it did not grow with cumulative tile uploads. These
OS counters include the browser's GPU context, swap chains and UI resources, so
they are larger than the 3.40 MiB of application-owned scalar textures. The initial
startup sample was 94.68 MiB dedicated / 26.32 MiB shared, then decreased.
Counter sampling was kept out of the primary timing comparison.
Raw counter samples:
[`terrain-webgl-1790647286093`](../.outputs/terrain-webgl-1790647286093/report.json).

## Historical rollout validation boundary

- 26 focused unit tests passed: scalar identity/halos, texture lifetime/budgets,
  existing terrain/chunks, SVG hook/layer, and wheel normalization.
- Production TypeScript check and Vite build passed. A production preview smoke
  test passed at DPR 2 with zero terrain/grid SVG nodes, then verified the explicit
  SVG flag. Browser console/page errors: none. Writes to the live backend were
  intercepted and the world was projected empty for this smoke check.
- All four new WebGL Playwright cases passed. Existing boundary pan, nested
  knowledge background isolation, selection/marquee, edge auto-pan, two connection
  drag tests and the legacy grid test passed in focused runs.
- The initial combined 11-test run had eight passes, an edge-auto-pan timeout and
  two following selection tests whose cards were outside the inherited viewport.
  Fresh isolated runs passed the edge-auto-pan test and both selection tests.
  Existing cross-test persisted viewport state was not refactored in this change.
- This is standalone headless Edge evidence. VS Code's embedded browser, desktop
  packaging, other GPU drivers and the complete application regression suite were
  not validated here.

## Legacy removal validation (2026-09-29)

- Removed the SVG components, their worker response/path generation/cache, the
  Canvas2D experiment, renderer switches, obsolete CSS and SVG-only tests.
  Field generation, seed semantics and the bounded scalar/GPU caches are retained.
- 17 focused field/scalar/texture/chunk tests and the production build passed.
- Eight focused standalone Edge cases passed: camera/card interaction, DPR/theme/
  seed/resize/context restoration, long-distance cache eviction, missing WebGL2,
  procedural grid pixel alignment, both zoom limits in both themes, distant tile
  streaming and uncached pan coverage. The first combined run passed seven; the
  theme test initially read the theme before initialization, then passed after
  adding the missing readiness assertion.
- Missing WebGL2 leaves the shell theme color visible. Pan, zoom and theme switching
  are verified in that state; no SVG background is mounted, even with the old URL
  flag. Context restoration redraws the same accepted WebGL visual.
- Historical reports above remain available. Maintained terrain benchmarks now
  measure WebGL only; further populated-card optimization is a separate task.
- The cleaned WebGL-only benchmark passed a near-scene smoke run: pan/zoom p95
  both 16.8 ms, maxima 16.9 ms, no intervals over 34 ms and no page errors.
  [Raw report](../.outputs/terrain-webgl-1790650455979/report.json).
