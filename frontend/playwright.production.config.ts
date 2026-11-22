import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e-production',
  outputDir: './e2e-results/production',
  reporter: 'list',
  workers: 1,
  timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:8790', channel: process.env.E2E_BROWSER_CHANNEL || undefined },
  webServer: {
    command: 'node ../backend/node_modules/wrangler/bin/wrangler.js dev --config ../wrangler.jsonc --port 8790',
    url: 'http://127.0.0.1:8790/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
})
