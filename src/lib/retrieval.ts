import { Prisma } from "@prisma/client";
import { Client } from "pg";
import { indexIncrementally } from "./reindexing";
import { db } from "./db";
import { tokens, neuralEmbeddings, embeddingRevision } from "./embeddings";
import { hash, chunkArticles, bundledKnowledge } from "./knowledge";
import { AppError } from "./errors";
import type { RetrievalDiagnostics, Settings, Source } from "./types";
type Row = {
  id: string;
  articleId: string;
  title: string;
  section: string;
  content: string;
  index: number;
  checksum: string;
  filename: string;
  version: string;
  embeddingHash: string;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
  embeddingV2Hash?: string | null;
  hasEmbeddingV2?: boolean;
};
export async function corpus(tx = db()) {
  return tx.$queryRaw<
    Row[]
  >`SELECT c.id,c."articleId",c.title,c.section,c.content,c.index,c.checksum,c."embeddingHash",c."embeddingV2Hash",c."embeddingModel",c."embeddingDimensions",(c."embeddingV2" IS NOT NULL) AS "hasEmbeddingV2",d.name AS filename,v.checksum AS version FROM "Chunk" c JOIN "DocumentVersion" v ON v.id=c."versionId" JOIN "Document" d ON d.id=v."documentId" WHERE v.active=true ORDER BY d.name,c."articleId",c.index`;
}
export function lexicalScore(query: string, text: string) {
  const qt = [...new Set(tokens(query))],
    ts = new Set(tokens(text));
  return qt.length ? qt.filter((t) => ts.has(t)).length / qt.length : 0;
}
export function rerank(
  query: string,
  rows: (Row & { semantic: number; fts?: number })[],
  s: Settings,
): Source[] {
  const code = query.match(/\bAD-\d{3}\b/i)?.[0];
  return rows
    .map((row) => {
      let score =
        s.semanticWeight * Math.max(0, row.semantic) +
        (1 - s.semanticWeight) * lexicalScore(query, row.content);
      // Exact error-code match distinguishes AD-413 from HTTP 413.
      if (code && row.content.toLowerCase().includes(code.toLowerCase() + ":"))
        score = Math.max(score, 0.95);
      return { ...row, score };
    })
    .filter((r) => r.score >= s.threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, s.topK);
}
type HybridRow = Row & { semantic: number };
/** Okapi BM25 over the active chunk corpus (k1=1.2, b=0.75). Scores are raw BM25. */
export function bm25Scores(query: string, rows: Row[]) {
  const terms = [...new Set(tokens(query))];
  const docs = rows.map((row) => tokens(row.content));
  const lengths = docs.map((doc) => doc.length);
  const avgLength = lengths.reduce((sum, n) => sum + n, 0) / (rows.length || 1);
  const df = new Map<string, number>();
  for (const doc of docs)
    for (const term of new Set(doc)) df.set(term, (df.get(term) || 0) + 1);
  const code = query.match(/\bAD-\d{3}\b/i)?.[0].toLowerCase();
  return rows
    .map((row, i) => {
      const tf = new Map<string, number>();
      for (const term of docs[i]) tf.set(term, (tf.get(term) || 0) + 1);
      const score = terms.reduce((sum, term) => {
        const count = tf.get(term) || 0;
        if (!count) return sum;
        const n = df.get(term) || 0;
        const idf = Math.log(1 + (rows.length - n + 0.5) / (n + 0.5));
        return (
          sum +
          (idf * (count * 2.2)) /
            (count + 1.2 * (0.25 + (0.75 * lengths[i]) / (avgLength || 1)))
        );
      }, 0);
      const exactCode =
        !!code && row.content.toLowerCase().includes(code + ":");
      return { ...row, bm25Score: score, exactCode };
    })
    .sort(
      (a, b) =>
        Number(b.exactCode) - Number(a.exactCode) || b.bm25Score - a.bm25Score,
    );
}
export function bm25Rank(query: string, rows: Row[], limit = 40) {
  return (
    bm25Scores(query, rows)
      // Ignore incidental one-token hits; retain exact technical-code matches.
      .filter((row) => row.bm25Score >= 0.45 || row.exactCode)
      .slice(0, limit)
  );
}
export function hybridRank(query: string, rows: HybridRow[], s: Settings) {
  const vectors = [...rows]
    .sort((a, b) => b.semantic - a.semantic)
    .filter((row) => row.semantic >= s.threshold)
    .slice(0, 40);
  const lexicalScores = new Map(
    bm25Scores(query, rows).map((row) => [row.id, row]),
  );
  const lexical = [...lexicalScores.values()]
    // Ignore incidental one-token hits; retain exact technical-code matches.
    .filter((row) => row.bm25Score >= 0.45 || row.exactCode)
    .slice(0, 40);
  const vectorMap = new Map(
    vectors.map((row, i) => [row.id, { row, rank: i + 1 }]),
  );
  const lexicalMap = new Map(
    lexical.map((row, i) => [row.id, { row, rank: i + 1 }]),
  );
  const toSource = (row: Row, extra: Partial<Source>): Source => ({
    ...row,
    score: 0,
    vectorScore: null,
    bm25Score: null,
    vectorRank: null,
    bm25Rank: null,
    ...extra,
  });
  const vectorResults = vectors.map((row, i) =>
    toSource(row, {
      score: row.semantic,
      vectorScore: row.semantic,
      vectorRank: i + 1,
      position: i + 1,
    }),
  );
  const bm25Results = lexical.map((row, i) =>
    toSource(row, {
      score: row.bm25Score,
      bm25Score: row.bm25Score,
      bm25Rank: i + 1,
      position: i + 1,
    }),
  );
  const ids = new Set([...vectorMap.keys(), ...lexicalMap.keys()]);
  const code = query.match(/\bAD-\d{3}\b/i)?.[0].toLowerCase();
  const sources = [...ids]
    .map((id) => {
      const v = vectorMap.get(id),
        b = lexicalMap.get(id),
        row = v?.row || b!.row;
      const exact = !!code && row.content.toLowerCase().includes(code + ":");
      return toSource(row, {
        vectorScore: v?.row.semantic ?? null,
        bm25Score: b?.row.bm25Score ?? null,
        vectorRank: v?.rank ?? null,
        bm25Rank: b?.rank ?? null,
        score:
          (v ? 1 / (60 + v.rank) : 0) +
          (b ? 1 / (60 + b.rank) : 0) +
          (exact ? 1 : 0),
      });
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, s.topK)
    .map((source, i) => ({ ...source, position: i + 1 }));
  const selectedIds = new Set(sources.map((source) => source.id));
  const excludedFromContext = rows
    .filter((row) => !selectedIds.has(row.id))
    .map((row) => {
      const eligibleVector = row.semantic >= s.threshold;
      const bm25 = lexicalScores.get(row.id);
      const eligibleBm25 = Boolean(
        bm25 && (bm25.bm25Score >= 0.45 || bm25.exactCode),
      );
      const retrieved = vectorMap.has(row.id) || lexicalMap.has(row.id);
      return {
        id: row.id,
        articleId: row.articleId,
        title: row.title,
        reason: retrieved
          ? "outside_top_k"
          : eligibleVector || eligibleBm25
            ? "outside_candidate_limit"
            : "below_relevance_threshold",
      } as const;
    });
  const diagnostics: RetrievalDiagnostics = {
    vectorResults,
    bm25Results,
    overlapIds: [...vectorMap.keys()].filter((id) => lexicalMap.has(id)),
    excludedFromContext,
  };
  return { sources, diagnostics };
}
export async function retrieve(query: string, s: Settings) {
  const configuredModel =
    process.env.EMBEDDING_MODEL || "Qwen/Qwen3-Embedding-8B";
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 4096);
  const expectedRevision = embeddingRevision(configuredModel, dimensions);
  // Readiness check and external embedding request happen before opening the
  // short, repeatable-read transaction used for the actual vector query.
  const initialRows = await corpus();
  if (!initialRows.length)
    throw new AppError(409, "Индекс пуст. Импортируйте базу знаний.");
  if (
    !dimensions ||
    initialRows.some(
      (r) =>
        r.embeddingModel !== configuredModel ||
        r.embeddingDimensions !== dimensions ||
        r.embeddingV2Hash !== expectedRevision ||
        !r.hasEmbeddingV2,
    )
  )
    throw new AppError(
      409,
      "Нейросетевой индекс не готов. Сначала выполните явную переиндексацию.",
    );
  const queryEmbedding = await neuralEmbeddings([query]);
  const revision = embeddingRevision(
    queryEmbedding.model,
    queryEmbedding.dimensions,
  );
  if (
    queryEmbedding.model !== configuredModel ||
    queryEmbedding.dimensions !== dimensions ||
    revision !== expectedRevision
  )
    throw new AppError(
      409,
      "Нейросетевой индекс отсутствует или требует переиндексации.",
    );
  const vector = JSON.stringify(queryEmbedding.vectors[0]);
  return db().$transaction(
    async (tx) => {
      const rows = await corpus(tx as unknown as ReturnType<typeof db>);
      if (
        rows.length !== initialRows.length ||
        rows.some(
          (r, i) =>
            r.id !== initialRows[i].id ||
            r.version !== initialRows[i].version ||
            r.embeddingV2Hash !== expectedRevision ||
            !r.hasEmbeddingV2,
        )
      )
        throw new AppError(
          409,
          "Индекс изменился во время поиска. Повторите запрос.",
        );
      const candidates = await tx.$queryRaw<
        (Row & { semantic: number })[]
      >(Prisma.sql`
 SELECT c.id,c."articleId",c.title,c.section,c.content,c.index,c.checksum,c."embeddingHash",d.name AS filename,v.checksum AS version,1-(c."embeddingV2" <=> ${vector}::vector) AS semantic
 FROM "Chunk" c JOIN "DocumentVersion" v ON v.id=c."versionId" JOIN "Document" d ON d.id=v."documentId" WHERE v.active=true AND c."embeddingModel"=${queryEmbedding.model} AND c."embeddingDimensions"=${queryEmbedding.dimensions} AND c."embeddingV2Hash"=${revision} AND c."embeddingV2" IS NOT NULL`);
      const ranked = hybridRank(query, candidates, s);
      return { ...ranked, indexHash: revision };
    },
    { isolationLevel: "RepeatableRead", timeout: 30000 },
  );
}
export async function offlineRetrieve(query: string, s: Settings) {
  const text = await bundledKnowledge(),
    chunks = chunkArticles(text),
    rows = chunks.map((c) => ({
      ...c,
      id: c.checksum,
      filename: "AgentDesk_Knowledge.md",
      version: hash(text),
      embeddingHash: "markdown-bm25-only",
    }));
  const bm25 = bm25Rank(query, rows, Math.max(1, s.topK));
  const bm25Results = bm25.map((row, i) => ({
    ...row,
    score: row.bm25Score,
    bm25Rank: i + 1,
    vectorScore: null,
    vectorRank: null,
    position: i + 1,
  }));
  const ids = new Set(bm25Results.map((row) => row.id));
  return {
    sources: bm25Results,
    vectorResults: [],
    bm25Results,
    overlapIds: [],
    excludedFromContext: rows
      .filter((row) => !ids.has(row.id))
      .map((row) => ({
        id: row.id,
        articleId: row.articleId,
        title: row.title,
        reason: "below_relevance_threshold" as const,
      })),
    diagnostics: {
      vectorResults: [],
      bm25Results,
      overlapIds: [],
      excludedFromContext: [],
    },
    indexHash: hash("markdown-bm25-v1:" + text),
  };
}
export async function reindexAll() {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("DIRECT_URL is required for safe neural reindexing.");
  const parsed = new URL(connectionString);
  if (parsed.hostname.includes("-pooler.") || !parsed.hostname.endsWith(".neon.tech"))
    throw new Error("Neural reindexing requires a direct Neon connection.");
  if (!process.env.REINDEX_NEURAL_EXPECTED_HOST || parsed.hostname !== process.env.REINDEX_NEURAL_EXPECTED_HOST)
    throw new Error("Neural reindexing requires an exact REINDEX_NEURAL_EXPECTED_HOST match.");
  if (!process.env.REINDEX_NEURAL_EXPECTED_DATABASE)
    throw new Error("Neural reindexing requires REINDEX_NEURAL_EXPECTED_DATABASE.");
  if (
    process.env.REINDEX_NEURAL_EXPECTED_DATABASE === "agentdesk_rag" &&
    (!process.env.NEON_ACTIVE_HOST || parsed.hostname === process.env.NEON_ACTIVE_HOST)
  )
    throw new Error("Neural reindexing requires a test Neon host distinct from NEON_ACTIVE_HOST.");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const target = await client.query<{ name: string }>("SELECT current_database() AS name");
    if (target.rows[0]?.name !== process.env.REINDEX_NEURAL_EXPECTED_DATABASE)
      throw new Error("Refusing neural reindex: current database does not match REINDEX_NEURAL_EXPECTED_DATABASE.");
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(451395) AS locked",
    );
    if (!lock.rows[0]?.locked)
      throw new Error("A neural reindex is already running for this database.");
    return await reindexWithClient(client);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(451395)");
    } catch {
      // The connection may already be gone; PostgreSQL releases session locks.
    }
    await client.end().catch(() => undefined);
  }
}

async function reindexWithClient(client: Client) {
  const targetModel = process.env.EMBEDDING_MODEL || "Qwen/Qwen3-Embedding-8B";
  const targetDimensions = Number(process.env.EMBEDDING_DIMENSIONS || 4096);
  const revision = embeddingRevision(targetModel, targetDimensions);
  const progress = await indexIncrementally({
    next: async () => {
      const next = await client.query<Row>(
        `SELECT c.id,c.content,c."embeddingV2Hash",(c."embeddingV2" IS NOT NULL) AS "hasEmbeddingV2"
       FROM "Chunk" c JOIN "DocumentVersion" v ON v.id=c."versionId"
       WHERE v.active=true AND (c."embeddingV2Hash" IS DISTINCT FROM $1 OR c."embeddingV2" IS NULL)
       ORDER BY c.id LIMIT 1`,
        [revision],
      );
      return next.rows[0] || null;
    },
    // One input per request bounds ambiguous network/connection failures to at
    // most one potentially repeated billable embedding.
    embed: async (chunk) => {
      const result = await neuralEmbeddings([chunk.content]);
      if (result.model !== targetModel || result.dimensions !== targetDimensions)
        throw new Error(
          "RouterAI embedding model or dimensions differ from configured index.",
        );
      return result;
    },
    persist: async (chunk, result) => {
      const batchRevision = embeddingRevision(result.model, result.dimensions);
      const updated = await client.query(
        `UPDATE "Chunk" c SET "embeddingV2"=$1::vector,"embeddingV2Hash"=$2,"embeddingModel"=$3,"embeddingDimensions"=$4
       FROM "DocumentVersion" v WHERE c.id=$5 AND c."versionId"=v.id AND v.active=true
       AND (c."embeddingV2Hash" IS DISTINCT FROM $2 OR c."embeddingV2" IS NULL)`,
        [JSON.stringify(result.vectors[0]), batchRevision, result.model, result.dimensions, chunk.id],
      );
      if (!updated.rowCount)
        throw new Error(`Chunk ${chunk.id} was no longer active when its vector was saved.`);
    },
    onSaved: (saved) => console.log(`Neural reindex progress: saved ${saved} chunks in this run`),
  });
  const result = await client.query<{ total: string; pending: string }>(
    `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE c."embeddingV2Hash" IS DISTINCT FROM $1 OR c."embeddingV2" IS NULL)::text AS pending
     FROM "Chunk" c JOIN "DocumentVersion" v ON v.id=c."versionId" WHERE v.active=true`,
    [revision],
  );
  if (Number(result.rows[0]?.pending || 0) !== 0)
    throw new Error(
      "Neural reindex incomplete; existing vectors have been preserved and the command can be resumed.",
    );
  return { indexed: progress.saved, total: Number(result.rows[0]?.total || 0), requests: progress.requests };
}
export async function importDocument(name: string, text: string) {
  if (!text.trim())
    throw new AppError(400, "В документе нет извлекаемого текста.");
  const checksum = hash(text);
  return db().$transaction(
    async (tx) => {
      // Serialize corpus changes; indexing stays an explicit, separately approved action.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(451392)`;
      const doc = await tx.document.upsert({
        where: { name },
        create: { name },
        update: {},
      });
      const existing = await tx.documentVersion.findUnique({
        where: { documentId_checksum: { documentId: doc.id, checksum } },
      });
      await tx.documentVersion.updateMany({
        where: { documentId: doc.id },
        data: { active: false },
      });
      const version = existing
        ? await tx.documentVersion.update({
            where: { id: existing.id },
            data: { active: true },
          })
        : await tx.documentVersion.create({
            data: { documentId: doc.id, checksum, text },
          });
      if (!existing)
        await tx.chunk.createMany({
          data: chunkArticles(
            text,
            Number(process.env.RAG_CHUNK_TOKENS || 800),
            Number(process.env.RAG_CHUNK_OVERLAP || 120),
          ).map((c) => ({
            ...c,
            versionId: version.id,
            embeddingHash: "pending",
          })),
        });
      return doc;
    },
    { timeout: 120000 },
  );
}
