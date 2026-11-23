// Playwright config for the 51 TCs in TEST-PLAN.md (tests/part-a.spec.js + tests/part-b.spec.js)
//
//   TEST_MODE=1 BUG_MODE= docker compose up --build -d
//   BASE_URL=http://localhost:3000 DB_PATH=data/egov.db npx playwright test
//
// Each TC calls POST /api/test/reset, which clears every session and all data on the server,
// so the whole suite must use one worker (workers: 1) and must not run fullyParallel.
const { defineConfig } = require('@playwright/test')
const fs = require('node:fs')

// This machine has a Chromium build that differs from Playwright 1.65 (1255). Use one found in /ms-playwright,
// or override it with CHROMIUM_PATH. On a machine where `npx playwright install` ran, nothing gets set.
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const candidates = [
    '/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chromium_headless_shell-1252/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell',
  ]
  return candidates.find(p => fs.existsSync(p))
}

const executablePath = chromiumPath()

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.js$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: process.env.PW_JSON || 'pw-report/results.json' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
})
