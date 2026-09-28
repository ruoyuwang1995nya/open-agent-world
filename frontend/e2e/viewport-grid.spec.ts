import { expect, test } from '@playwright/test';

test('composited grid preserves dot phase, size and viewport coverage', async ({ page, request }) => {
  const profile = await (await request.get('/api/application')).json();
  await request.patch('/api/application/preferences', { data: {
    profile_id: profile.profile_id, generation: profile.generation,
    changes: { 'oaw-onboarding-v1': JSON.stringify({ version: 1, state: { status: 'skipped' } }) },
  } });
  await page.goto('/');
  const grid = page.locator('#oaw-world-map > .world-grid');
  await expect(grid).toBeVisible();
  const check = async () => {
    const state = await grid.evaluate(el => {
      const root = el.parentElement!;
      const viewport = root.querySelector('.react-flow__viewport')!;
      const transform = new DOMMatrix(getComputedStyle(viewport).transform);
      const tile = [...el.querySelectorAll<SVGSVGElement>('svg')].find(tile => tile.style.opacity === '1')!;
      const translated = new DOMMatrix(getComputedStyle(tile).transform);
      const pattern = tile.querySelector('pattern')!;
      const gap = Number(pattern.getAttribute('width')) * translated.a;
      const bounds = tile.getBoundingClientRect(), canvas = root.getBoundingClientRect();
      const pad = -parseFloat(tile.style.left);
      return { gap, zoom: transform.a, scale: translated.a, x: translated.e - pad * (1 - translated.a), y: translated.f - pad * (1 - translated.a),
        expectedX: transform.e % gap, expectedY: transform.f % gap,
        radius: Number(tile.querySelector('circle')!.getAttribute('r')) * translated.a,
        covers: bounds.left <= canvas.left && bounds.top <= canvas.top && bounds.right >= canvas.right && bounds.bottom >= canvas.bottom,
      };
    });
    expect(state.covers).toBe(true);
    expect(state.radius).toBeCloseTo(1, 3);
    expect(state.x).toBeCloseTo(state.expectedX, 3);
    expect(state.y).toBeCloseTo(state.expectedY, 3);
    expect(state.gap).toBeGreaterThanOrEqual(16);
    expect(state.gap).toBeLessThanOrEqual(Math.max(40, 24 * state.zoom));
    expect(Math.log2(state.gap / (24 * state.zoom))).toBeCloseTo(Math.round(Math.log2(state.gap / (24 * state.zoom))), 3);
  };
  await expect(check).toPass();
  for (const end of [{ x: 320, y: 230 }, { x: 1140, y: 560 }]) {
    await page.mouse.move(800, 400);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 20 });
    await page.mouse.up();
    await check();
  }
  for (const selector of ['.react-flow__controls-zoomout', '.react-flow__controls-zoomin']) {
    for (let i = 0; i < 5; i++) await page.locator(`.world-controls ${selector}`).click();
    await expect(check).toPass();
  }
  await page.setViewportSize({ width: 1700, height: 1000 });
  await check();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `../.outputs/viewport-grid-${theme}.png` });
    await check();
  }
});
