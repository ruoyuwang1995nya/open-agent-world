import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test.use({ trace: 'off' });

test('continuous zoom retains terrain and bounds background repaint work', async ({ page, request }) => {
  test.setTimeout(100_000);
  const profile = await (await request.get('/api/application')).json();
  expect((await request.patch('/api/application/preferences', { data: {
    profile_id: profile.profile_id, generation: profile.generation, changes: {
      'oaw.locale': 'en', 'oaw-onboarding-v1': JSON.stringify({ version: 1, state: { status: 'skipped' } }),
      'oaw-canvas-viewport-v1': JSON.stringify({ version: 0, state: {
        viewport: { x: 80, y: 80, zoom: 0.22, width: 1920, height: 1080 }, mapPins: [],
      } }),
    },
  } })).ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await expect(page.locator('.top-bar')).toBeVisible();
  await expect.poll(() => page.locator('.contour-chunk').count()).toBeGreaterThan(25);
  await page.waitForTimeout(1200); // Warm the worker/prefetch ring before profiling.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Performance.enable');
  const reports = [];
  for (const mode of process.env.OAW_ZOOM_COMPARE ? ['normal', 'frozen', 'hidden'] : ['normal']) {
    const style = mode === 'normal' ? undefined : await page.addStyleTag({ content: mode === 'hidden'
      ? '.contour-chunk, .world-grid { visibility: hidden !important; }'
      : '.contour-minor { stroke-width: 5.2px !important; } .contour-major { stroke-width: 7.5px !important; } .contour-chunk { will-change: transform !important; }' });
    const before = await cdp.send('Performance.getMetrics');
    const report = await page.evaluate(async () => {
      const world = document.querySelector('#oaw-world-map')!;
      const surface = world.querySelector('.react-flow__viewport')!;
      const terrain = world.querySelector('.contour-layer')!;
      const grid = world.querySelector('.world-grid')!;
      const frames: number[] = [], longTasks: number[] = [];
      let paintAttributes = 0, pathChanges = 0, emptyTerrainFrames = 0, active = true;
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.target === terrain || record.target instanceof SVGPatternElement) paintAttributes++;
          if (record.attributeName === 'd') pathChanges++;
        }
      });
      observer.observe(terrain, { subtree: true, attributes: true });
      observer.observe(grid, { subtree: true, attributes: true });
      const tasks = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
      tasks.observe({ type: 'longtask' });
      let previous = performance.now();
      const tick = (now: number) => {
        frames.push(now - previous); previous = now;
        if (!terrain.querySelector('.contour-chunk')) emptyTerrainFrames++;
        if (active) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const initial = new DOMMatrix(getComputedStyle(surface).transform).a;
      for (let pass = 0; pass < 2; pass++) for (const direction of [-1, 1]) {
        for (let i = 0; i < 20; i++) {
          world.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
            deltaY: direction * 40, clientX: 960, clientY: 540 }));
          await new Promise(resolve => setTimeout(resolve, 45));
        }
      }
      const during = { paintAttributes, pathChanges };
      await new Promise(resolve => setTimeout(resolve, 800));
      active = false; observer.disconnect(); tasks.disconnect();
      const sorted = frames.slice(1).sort((a, b) => a - b);
      return { initial, final: new DOMMatrix(getComputedStyle(surface).transform).a,
        frames: { count: sorted.length, p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1), over34: sorted.filter(n => n > 34).length },
        longTasks, during, total: { paintAttributes, pathChanges }, emptyTerrainFrames,
        tiles: terrain.querySelectorAll('.contour-chunk').length,
      };
    });
    const after = await cdp.send('Performance.getMetrics');
    reports.push({ mode, ...report, metrics: Object.fromEntries(after.metrics.filter(m => /Duration/.test(m.name))
      .map(m => [m.name, m.value - (before.metrics.find(b => b.name === m.name)?.value ?? 0)])) });
    expect(report.final).toBeCloseTo(report.initial, 4);
    expect(report.emptyTerrainFrames).toBe(0);
    if (!process.env.OAW_ZOOM_COMPARE) {
      expect(report.during.paintAttributes).toBeLessThan(120);
      expect(report.during.pathChanges).toBe(0);
      expect(report.total.pathChanges).toBe(0);
    }
    await style?.evaluate(element => element.remove());
  }
  console.log('ZOOM_RENDERING', JSON.stringify(reports));
  if (process.env.OAW_ZOOM_REPORT) await writeFile(process.env.OAW_ZOOM_REPORT, JSON.stringify(reports, null, 2));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `../.outputs/zoom-settled-${theme}.png` });
  }
});

test('terrain shapes remain identical across settled zoom levels and reload', async ({ page, request }) => {
  const profile = await (await request.get('/api/application')).json();
  expect((await request.patch('/api/application/preferences', { data: {
    profile_id: profile.profile_id, generation: profile.generation, changes: {
      'oaw-onboarding-v1': JSON.stringify({ version: 1, state: { status: 'skipped' } }),
      'oaw-canvas-viewport-v1': JSON.stringify({ version: 0, state: {
        viewport: { x: 640 - 1024 * 0.8, y: 400 - 1024 * 0.8, zoom: 0.8, width: 1280, height: 800 }, mapPins: [],
      } }),
    },
  } })).ok()).toBe(true);
  await page.goto('/');
  const tile = page.locator('.contour-chunk[data-chunk="0:0"]');
  await expect(tile).toHaveAttribute('data-resolution', '56');
  const paths = () => tile.locator('path').evaluateAll(paths => paths.map(path => path.getAttribute('d')));
  const reference = await paths();
  expect(reference.length).toBeGreaterThan(2);
  const viewport = page.locator('#oaw-world-map .react-flow__viewport').first();
  const zoom = () => viewport.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
  await page.mouse.move(640, 400);
  for (const target of [0.12, 2.2, 0.4, 1.2, 0.8]) {
    await page.mouse.wheel(0, -Math.log2(target / await zoom()) / 0.002);
    await expect.poll(zoom).toBeCloseTo(target, 4);
    // Waiting for settled stroke compensation also catches old post-zoom LOD swaps.
    await expect.poll(async () => {
      const stroke = await tile.locator('.contour-minor').evaluate(el => parseFloat(getComputedStyle(el).strokeWidth));
      return stroke * await zoom();
    }).toBeCloseTo(1.15, 3);
    await expect(tile).toHaveAttribute('data-resolution', '56');
    expect(await paths()).toEqual(reference);
  }
  await page.reload();
  await expect(tile).toHaveAttribute('data-resolution', '56');
  expect(await paths()).toEqual(reference);
});
