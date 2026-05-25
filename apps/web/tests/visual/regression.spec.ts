import { test, expect } from '@playwright/test';

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

test.describe('Dashboard Visual Regression', () => {
  for (const route of DASHBOARDS) {
    test(`Visual check for ${route}`, async ({ page }) => {
      test.setTimeout(120000); // 2 minutes timeout per test for safety
      
      const routeName = route.split('/').pop() || 'index';
      
      await page.setViewportSize({ width: 1280, height: 800 });
      
      await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 60000 });
      
      // Wait for ECharts instances
      await page.waitForFunction(() => {
        const chartElements = document.querySelectorAll('[_echarts_instance_]');
        if (chartElements.length === 0) return false;
        return Array.from(chartElements).some(el => el.getAttribute('_echarts_instance_'));
      }, { timeout: 60000 });
      
      // Add a slight delay for animations to finish
      await page.waitForTimeout(3000);
      
      // Assert full page screenshot matches baseline
      await expect(page).toHaveScreenshot(`${routeName}-desktop.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.05, // Allow small differences
      });
      
      // Mobile narrow
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForTimeout(1000);
      
      await expect(page).toHaveScreenshot(`${routeName}-mobile.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.05,
      });
    });
  }
});
