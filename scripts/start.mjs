import { spawn } from "node:child_process";
if (!process.env.DEMO_ACCESS_PASSWORD || !process.env.DATABASE_URL) {
  console.error(
    "Railway startup requires DEMO_ACCESS_PASSWORD and DATABASE_URL",
  );
  process.exit(1);
}
const children = [
  spawn("node", ["--import", "tsx", "scripts/worker.ts"], { stdio: "inherit" }),
  spawn(
    "node",
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "0.0.0.0",
      "--port",
      process.env.PORT || "3000",
    ],
    { stdio: "inherit" },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 5000).unref();
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop());
for (const child of children) child.on("exit", (code) => stop(code || 1));
