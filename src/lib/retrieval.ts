import { Prisma } from "@prisma/client";
import { db } from "./db";
import { adapter, cosine, tokens } from "./embeddings";
import { hash, chunkArticles, bundledKnowledge } from "./knowledge";
import { AppError } from "./errors";
import type { Settings, Source } from "./types";
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
};
export async function corpus(tx = db()) {
  return tx.$queryRaw<
    Row[]
  >`SELECT c.id,c."articleId",c.title,c.section,c.content,c.index,c.checksum,c."embeddingHash",d.name AS filename,v.checksum AS version FROM "Chunk" c JOIN "DocumentVersion" v ON v.id=c."versionId" JOIN "Document" d ON d.id=v."documentId" WHERE v.active=true ORDER BY d.name,c."articleId",c.index`;
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
export async function retrieve(query: string, s: Settings) {
  return db().$transaction(
    async (tx) => {
      const rows = await corpus(tx as unknown as ReturnType<typeof db>);
      if (!rows.length)
        throw new AppError(409, "Индекс пуст. Импортируйте базу знаний.");
      const model = adapter(rows.map((r) => r.content));
      if (rows.some((r) => r.embeddingHash !== model.hash))
        throw new AppError(
          409,
          "Индекс требует переиндексации: версия embedding-адаптера изменилась.",
        );
      const vector = JSON.stringify(model.embed([query])[0]);
      const candidates = await tx.$queryRaw<
        (Row & { semantic: number; fts: number })[]
      >(Prisma.sql`
 WITH semantic AS (SELECT c.id FROM "Chunk" c JOIN "DocumentVersion" v ON v.id=c."versionId" WHERE v.active=true ORDER BY c.embedding <=> ${vector}::vector LIMIT 40),
 lexical AS (SELECT c.id FROM "Chunk" c JOIN "DocumentVersion" v ON v.id=c."versionId" WHERE v.active=true AND to_tsvector('russian',c.content) @@ plainto_tsquery('russian',${query}) LIMIT 40)
 SELECT c.id,c."articleId",c.title,c.section,c.content,c.index,c.checksum,c."embeddingHash",d.name AS filename,v.checksum AS version,1-(c.embedding <=> ${vector}::vector) AS semantic,ts_rank_cd(to_tsvector('russian',c.content),plainto_tsquery('russian',${query})) AS fts
 FROM "Chunk" c JOIN "DocumentVersion" v ON v.id=c."versionId" JOIN "Document" d ON d.id=v."documentId" WHERE c.id IN(SELECT id FROM semantic UNION SELECT id FROM lexical)`);
      return { sources: rerank(query, candidates, s), indexHash: model.hash };
    },
    { isolationLevel: "RepeatableRead", timeout: 30000 },
  );
}
export async function offlineRetrieve(query: string, s: Settings) {
  const text = await bundledKnowledge(),
    chunks = chunkArticles(text),
    model = adapter(chunks.map((c) => c.content));
  const queryVector = model.embed([query])[0],
    vectors = model.embed(chunks.map((c) => c.content));
  return {
    sources: rerank(
      query,
      chunks.map((c, i) => ({
        ...c,
        id: c.checksum,
        filename: "AgentDesk_Knowledge.md",
        version: hash(text),
        embeddingHash: model.hash,
        semantic: cosine(queryVector, vectors[i]),
      })),
      s,
    ),
    indexHash: model.hash,
  };
}
export async function reindexAll(tx = db()) {
  const rows = await corpus(tx);
  if (!rows.length) return;
  const model = adapter(rows.map((r) => r.content)),
    vectors = model.embed(rows.map((r) => r.content));
  for (let i = 0; i < rows.length; i++)
    await tx.$executeRaw`UPDATE "Chunk" SET embedding=${JSON.stringify(vectors[i])}::vector,"embeddingHash"=${model.hash} WHERE id=${rows[i].id}`;
}
export async function importDocument(name: string, text: string) {
  if (!text.trim())
    throw new AppError(400, "В документе нет извлекаемого текста.");
  const checksum = hash(text);
  return db().$transaction(
    async (tx) => {
      // Serialize corpus changes so a reader cannot observe partially rebuilt vectors.
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
      await reindexAll(tx as unknown as ReturnType<typeof db>);
      return doc;
    },
    { timeout: 120000 },
  );
}
