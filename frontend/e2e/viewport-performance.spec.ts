import { expect, test } from '@playwright/test';

test('pan across uncached terrain and zoom without losing terrain coverage', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(page.locator('.contour-chunk').first()).toBeAttached();
  await page.waitForTimeout(1500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate(() => {
    const w = window as any;
    w.panFrames = []; w.panLongTasks = []; w.panActive = true;
    w.panObserver = new PerformanceObserver(list => {
      w.panLongTasks.push(...list.getEntries().map(entry => entry.duration));
    });
    w.panObserver.observe({ type: 'longtask', buffered: false });
    let previous = performance.now();
    const tick = (now: number) => {
      w.panFrames.push(now - previous); previous = now;
      if (w.panActive) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const viewport = page.locator('#oaw-world-map > .react-flow__renderer .react-flow__viewport').first();
  const origin = await viewport.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e);
  for (let pass = 0; pass < 8; pass++) {
    await page.mouse.move(1100, 400);
    await page.mouse.down();
    await page.mouse.move(200, 400, { steps: 30 });
    await page.mouse.up();
  }
  expect(await viewport.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBeLessThan(origin - 6500);
  const report = await page.evaluate(() => {
    const w = window as any; w.panActive = false; w.panObserver.disconnect();
    const gaps = w.panFrames.slice(1).sort((a: number, b: number) => a - b);
    return { frames: gaps.length, p95: gaps[Math.floor(gaps.length * .95)], max: gaps.at(-1),
      over34ms: gaps.filter((v: number) => v > 34).length, longTasks: w.panLongTasks };
  });
  console.log('VIEWPORT_PERFORMANCE', JSON.stringify(report));
  const checkCoverage = () => page.evaluate(() => {
    const world = document.querySelector('#oaw-world-map')!;
    const matrix = new DOMMatrix(getComputedStyle(world.querySelector('.react-flow__viewport')!).transform);
    const keys = new Set(Array.from(world.querySelectorAll('.contour-chunk')).map(el => el.getAttribute('data-chunk')));
    for (let y = Math.floor(-matrix.f / matrix.a / 2048); y <= Math.floor((world.clientHeight - matrix.f) / matrix.a / 2048); y++) {
      for (let x = Math.floor(-matrix.e / matrix.a / 2048); x <= Math.floor((world.clientWidth - matrix.e) / matrix.a / 2048); x++) {
        if (!keys.has(`${x}:${y}`)) return false;
      }
    }
    return true;
  });
  await expect.poll(checkCoverage).toBe(true);
  await page.mouse.move(700, 400);
  for (let step = 0; step < 4; step++) await page.locator('.world-controls .react-flow__controls-zoomin').click();
  await expect.poll(() => page.locator('.contour-chunk').evaluateAll(chunks => chunks.every(el => el.getAttribute('data-resolution') === '56'))).toBe(true);
  await expect.poll(checkCoverage).toBe(true);
  await page.screenshot({ path: '../.outputs/viewport-performance.png' });
});
