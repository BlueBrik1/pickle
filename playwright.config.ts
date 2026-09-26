import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3001',
    headless: true,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: [
    {
      command: 'npm start',
      url: 'http://127.0.0.1:3001/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'npm start',
      url: 'http://127.0.0.1:3002/api/health',
      env: { PORT: '3002', PICKLE_MODE: 'demo' },
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
  reporter: [['list'], ['html', { open: 'never' }]],
});
