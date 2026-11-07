// Read-only comparison of all pre-migration application data. Never logs URLs or row values.
import { Client } from "pg";
import { createHash } from "node:crypto";
const tables = [
  "Document",
  "DocumentVersion",
  "Chunk",
  "ChatSession",
  "Message",
  "ModelConfig",
  "EvaluationCase",
  "EvaluationRun",
  "EvaluationResult",
  "PricingSnapshot",
  "RateLimit",
];
async function fingerprints(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  const result: Record<string, { count: number; sha256: string }> = {};
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const table of tables) {
      // New execution metadata is intentionally absent in the old Railway schema.
      const omit =
        table === "EvaluationRun"
          ? " - ARRAY['executor','nextBatch','leaseToken','leaseExpiresAt']"
          : "";
      const rows = await client.query(
        `SELECT (to_jsonb(t)${omit})::text AS row FROM "${table}" t ORDER BY id`,
      );
      const digest = createHash("sha256");
      for (const row of rows.rows) digest.update(row.row + "\n");
      result[table] = { count: rows.rowCount!, sha256: digest.digest("hex") };
    }
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}
async function main() {
  const source = process.env.SOURCE_DATABASE_URL;
  const target = process.env.TARGET_DIRECT_URL;
  if (!source || !target)
    throw new Error("Source and target configuration required");
  const [before, after] = await Promise.all([
    fingerprints(source),
    fingerprints(target),
  ]);
  const comparison = tables.map((table) => ({
    table,
    sourceCount: before[table].count,
    targetCount: after[table].count,
    matches:
      before[table].count === after[table].count &&
      before[table].sha256 === after[table].sha256,
  }));
  console.log(JSON.stringify(comparison, null, 2));
  if (comparison.some((row) => !row.matches)) process.exitCode = 1;
}
main().catch(() => {
  console.error(
    "Read-only migration verification failed; check connectivity, permissions and both schemas.",
  );
  process.exitCode = 1;
});
