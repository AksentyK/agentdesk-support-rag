import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
process.env.TEST_DEMO_PASSWORD ||= randomBytes(24).toString("hex");
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://localhost:3187",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    },
  },
  webServer: {
    command: "npm run start:railway",
    url: "http://localhost:3187/api/health",
    timeout: 60000,
    reuseExistingServer: false,
    env: {
      PORT: "3187",
      NODE_ENV: "production",
      DEMO_ACCESS_PASSWORD: process.env.TEST_DEMO_PASSWORD,
      ROUTERAI_API_KEY: "",
      DATABASE_URL: process.env.DATABASE_URL || "",
    },
  },
});
