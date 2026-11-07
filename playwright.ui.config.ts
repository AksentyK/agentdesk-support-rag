import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "lab.spec.ts",
  grep: /chat exposes real API diagnostics tabs/,
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://localhost:3191",
    launchOptions: { executablePath: "/usr/bin/chromium" },
  },
  webServer: {
    command: "npm run dev -- --port 3191",
    url: "http://localhost:3191/",
    timeout: 90000,
    reuseExistingServer: false,
  },
});
