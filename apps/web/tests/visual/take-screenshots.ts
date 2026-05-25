import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DASHBOARDS = [
  '/dashboards/reserving',
  '/dashboards/mortality',
  '/dashboards/pensions',
  '/dashboards/pricing',
  '/dashboards/regulatory',
  '/dashboards/climate',
  '/dashboards/capital',
  '/dashboards/documentation'
];

const BASE_URL = 'http://localhost:5175';

async function takeScreenshots() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(__dirname, 'screenshots', timestamp);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  
  for (const route of DASHBOARDS) {
    console.log(`Processing ${route}...`);
    const page = await context.newPage();
    const routeName = route.split('/').pop() || 'index';
    
    // Default Desktop
    await page.setViewportSize({ width: 1280, height: 800 });
    
    try {
        await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (e) {
        console.warn(`Failed to navigate to ${route}: ${e}`);
        await page.close();
        continue;
    }
    
    // Wait for ECharts instances
    try {
      await page.waitForFunction(() => {
        const chartElements = document.querySelectorAll('[_echarts_instance_]');
        if (chartElements.length === 0) return false;
        // Check that at least some charts have an instance attached (sometimes loading takes a bit)
        return Array.from(chartElements).some(el => el.getAttribute('_echarts_instance_'));
      }, { timeout: 60000 });
      // Add a slight delay for animations and API loading to finish fully
      await page.waitForTimeout(3000);
    } catch (e) {
      console.warn(`Timeout waiting for charts on ${route}`);
    }

    // Full page screenshot desktop
    await page.screenshot({ path: path.join(outDir, `${routeName}-desktop.png`), fullPage: true });

    // Chart element screenshots desktop
    const chartElements = await page.$$('[_echarts_instance_]');
    for (let i = 0; i < chartElements.length; i++) {
      try {
        await chartElements[i].screenshot({ path: path.join(outDir, `${routeName}-chart-${i}-desktop.png`) });
      } catch (e) {
        console.warn(`Failed to screenshot chart ${i} on ${route}`);
      }
    }
    
    // Interactive state (e.g. tooltip hover)
    if (chartElements.length > 0) {
        try {
            const bbox = await chartElements[0].boundingBox();
            if (bbox) {
                await page.mouse.move(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
                await page.waitForTimeout(1000); // Wait for tooltip to appear
                await chartElements[0].screenshot({ path: path.join(outDir, `${routeName}-chart-0-hover.png`) });
            }
        } catch (e) {
            console.warn(`Failed hover screenshot for ${route}`);
        }
    }

    // Mobile Narrow
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(1000); // Wait for resize relayout
    await page.screenshot({ path: path.join(outDir, `${routeName}-mobile.png`), fullPage: true });

    await page.close();
  }

  await browser.close();
  console.log(`Saved screenshots to ${outDir}`);
}

takeScreenshots().catch(console.error);
