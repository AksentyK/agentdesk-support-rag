import { reindexAll } from "../src/lib/retrieval";

async function main() {
  if (!process.argv.includes("--execute")) {
    console.log(
      "Dry run only. To make billable RouterAI embedding requests, rerun with --execute after explicit approval.",
    );
    return;
  }
  if (process.env.REINDEX_NEURAL_CONFIRM !== "YES")
    throw new Error(
      "Set REINDEX_NEURAL_CONFIRM=YES after confirming target database and API spend.",
    );
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is required for neural reindexing.");
  const parsed = new URL(url);
  if (
    parsed.hostname.includes("-pooler.") ||
    !parsed.hostname.endsWith(".neon.tech")
  )
    throw new Error(
      "Reindex requires the verified Neon direct URL; pooled or non-Neon URLs are rejected.",
    );
  if (!process.env.REINDEX_NEURAL_EXPECTED_HOST)
    throw new Error(
      "Set REINDEX_NEURAL_EXPECTED_HOST to the exact direct Neon hostname shown in the dashboard.",
    );
  if (parsed.hostname !== process.env.REINDEX_NEURAL_EXPECTED_HOST)
    throw new Error(
      "Refusing to reindex: DIRECT_URL host does not match REINDEX_NEURAL_EXPECTED_HOST.",
    );
  if (!process.env.REINDEX_NEURAL_EXPECTED_DATABASE)
    throw new Error(
      "Set REINDEX_NEURAL_EXPECTED_DATABASE to the exact database name shown by Neon.",
    );
  if (process.env.REINDEX_NEURAL_EXPECTED_DATABASE === "agentdesk_rag") {
    if (!process.env.NEON_ACTIVE_HOST)
      throw new Error("Set NEON_ACTIVE_HOST so the test branch host can be distinguished from the active Neon branch.");
    if (parsed.hostname === process.env.NEON_ACTIVE_HOST)
      throw new Error("Refusing neural reindex: target host matches the active Neon branch.");
  }
  const { Client } = await import("pg");
  const guard = new Client({ connectionString: url });
  await guard.connect();
  let targetName: string;
  try {
    const target = await guard.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    targetName = target.rows[0]?.name;
  } finally {
    await guard.end();
  }
  if (targetName !== process.env.REINDEX_NEURAL_EXPECTED_DATABASE)
    throw new Error(
      "Refusing to reindex: current database does not match REINDEX_NEURAL_EXPECTED_DATABASE.",
    );
  console.log(
    `Target database verified: ${targetName} on ${parsed.hostname}. Existing active-indexed chunks will be skipped.`,
  );
  process.env.DATABASE_URL = url;
  const result = await reindexAll();
  console.log(
    `Neural reindex complete: ${result.indexed}/${result.total} chunks indexed; ${result.requests} embedding requests made this run.`,
  );
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Neural reindex failed",
    );
    process.exitCode = 1;
  })
