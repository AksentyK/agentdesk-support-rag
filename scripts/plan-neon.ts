// Read-only preflight for an isolated Neon branch. Never calls RouterAI.
import { Client } from "pg";
import { embeddingRevision } from "../src/lib/embeddings";

async function main() {
  const url = process.env.DIRECT_URL;
  const expectedHost = process.env.NEON_TEST_EXPECTED_HOST;
  const expectedDatabase = process.env.NEON_TEST_EXPECTED_DATABASE;
  const activeHost = process.env.NEON_ACTIVE_HOST;
  if (!url || !expectedHost || !expectedDatabase || !activeHost)
    throw new Error("DIRECT_URL and exact test/active Neon target guards are required.");
  const parsed = new URL(url);
  if (!parsed.hostname.endsWith(".neon.tech") || parsed.hostname.includes("-pooler.") || parsed.hostname !== expectedHost || parsed.hostname === activeHost)
    throw new Error("Refusing preflight: target is not the exact isolated direct Neon host.");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = await client.query<{ database: string; host: string }>(
      "SELECT current_database() AS database, inet_server_addr()::text AS host",
    );
    if (identity.rows[0]?.database !== expectedDatabase)
      throw new Error("Connected database differs from NEON_TEST_EXPECTED_DATABASE.");
    const extension = await client.query<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS installed",
    );
    const table = await client.query<{ installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Chunk' AND column_name='embeddingV2') AS installed`,
    );
    let total: number | null = null;
    let pending: number | null = null;
    if (table.rows[0]?.installed) {
      const revision = embeddingRevision(process.env.EMBEDDING_MODEL || "Qwen/Qwen3-Embedding-8B", Number(process.env.EMBEDDING_DIMENSIONS || 4096));
      const counts = await client.query<{ total: string; pending: string }>(
        `SELECT count(*)::text AS total, count(*) FILTER (WHERE c."embeddingV2Hash" IS DISTINCT FROM $1 OR c."embeddingV2" IS NULL)::text AS pending
         FROM "Chunk" c JOIN "DocumentVersion" v ON v.id=c."versionId" WHERE v.active=true`,
        [revision],
      );
      total = Number(counts.rows[0].total);
      pending = Number(counts.rows[0].pending);
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ targetHost: parsed.hostname, database: expectedDatabase, vectorExtension: extension.rows[0]?.installed, neuralColumn: table.rows[0]?.installed, activeChunks: total, pendingEmbeddingRequests: pending, billableRequestsUpperBound: pending === null ? "unknown until migration" : pending }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Neon preflight failed"); process.exitCode = 1; });
