import { db } from "../src/lib/db";
import { executeRun } from "../src/lib/evaluation";
import { setTimeout } from "node:timers/promises";
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function main() {
  // One Railway replica: PostgreSQL advisory lock prevents competing workers.
  const pg = await import("pg");
  const lock = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await lock.connect();
  const claimed = await lock.query(
    "SELECT pg_try_advisory_lock(451393) AS locked",
  );
  if (!claimed.rows[0].locked)
    throw new Error("An evaluation worker is already running");
  await db().evaluationRun.updateMany({
    where: { status: "running" },
    data: { status: "interrupted" },
  });
  console.log("Evaluation worker ready");
  while (!stopping) {
    const run = await db().evaluationRun.findFirst({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
    });
    if (run) {
      await db().evaluationRun.update({
        where: { id: run.id },
        data: { status: "running" },
      });
      try {
        await executeRun(run.id);
      } catch {
        console.error("Evaluation interrupted:", run.id);
      }
    } else await setTimeout(1000);
  }
  await lock.end();
  await db().$disconnect();
}
main().catch(() => {
  console.error("Worker unavailable: check DATABASE_URL and migrations");
  process.exit(1);
});
