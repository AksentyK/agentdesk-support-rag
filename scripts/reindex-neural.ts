import { db } from "../src/lib/db";
import { reindexAll } from "../src/lib/retrieval";
let client: ReturnType<typeof db> | undefined;

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
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(url);
  if (
    parsed.hostname.includes("-pooler.") ||
    !parsed.hostname.endsWith(".neon.tech")
  )
    throw new Error(
      "Reindex requires the verified Neon direct URL; pooled or non-Neon URLs are rejected.",
    );
  client = db();
  const target = await client.$queryRaw<
    { name: string }[]
  >`SELECT current_database() AS name`;
  if (target[0]?.name !== "agentdesk_rag")
    throw new Error(
      "Refusing to reindex: current database is not agentdesk_rag.",
    );
  console.log(
    `Target database verified: ${target[0].name}. Only chunks missing the configured embedding revision will be requested.`,
  );
  const result = await reindexAll(client);
  console.log(
    `Neural reindex complete: ${result.indexed}/${result.total} chunks indexed.`,
  );
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Neural reindex failed",
    );
    process.exitCode = 1;
  })
  .finally(() => client?.$disconnect());
