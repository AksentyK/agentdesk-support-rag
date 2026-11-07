import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
async function main() {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DIRECT_URL or DATABASE_URL required");
  if (new URL(connectionString).hostname.includes("-pooler."))
    throw new Error("Migrations require the direct Neon endpoint");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(451394)");
    await client.query(
      'CREATE TABLE IF NOT EXISTS "_agentdesk_migrations" (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of (await readdir("prisma/migrations"))
      .filter((n) => !n.includes("."))
      .sort()) {
      const sql = await readFile(
          `prisma/migrations/${name}/migration.sql`,
          "utf8",
        ),
        checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query(
        'SELECT checksum FROM "_agentdesk_migrations" WHERE name=$1',
        [name],
      );
      if (previous.rows.length) {
        if (previous.rows[0].checksum !== checksum)
          throw new Error("Applied migration checksum mismatch: " + name);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO "_agentdesk_migrations"(name,checksum) VALUES ($1,$2)',
          [name, checksum],
        );
        await client.query("COMMIT");
        console.log("Applied migration:", name);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.end();
  }
}
main().catch(() => {
  console.error(
    "Migration failed: verify DATABASE_URL, pgvector extension privileges and migration integrity",
  );
  process.exitCode = 1;
});
