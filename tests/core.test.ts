import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  articles,
  bundledKnowledge,
  chunkArticles,
} from "../src/lib/knowledge";
import { LocalLSA, cosine } from "../src/lib/embeddings";
import { defaults, estimateCost } from "../src/lib/settings";
import {
  contextForModel,
  shouldRefuse,
  validateCitations,
} from "../src/lib/router";
import { dataset, splitCases } from "../src/lib/dataset";
import { bm25Rank, hybridRank, offlineRetrieve } from "../src/lib/retrieval";
import {
  passwordMatches,
  newSession,
  sessionOwner,
  rateLimit,
} from "../src/lib/auth";
import { csv, metrics } from "../src/lib/evaluation";
import { publicError } from "../src/lib/errors";
import { extract } from "../src/lib/documents";
test("KB parser ignores TOC and preserves 35 unique article IDs", async () => {
  const text = await bundledKnowledge(),
    a = articles(text);
  assert.equal(a.length, 35);
  assert.equal(new Set(a.map((a) => a.articleId)).size, 35);
  const chunks = chunkArticles(text, 180, 30);
  assert(chunks.length > 35);
  assert(
    chunks.every(
      (c) =>
        c.articleId &&
        c.section &&
        c.checksum.length === 64 &&
        c.content.length,
    ),
  );
  assert.throws(() => chunkArticles(text, 50, 60));
});
test("LSA embeds into finite 256D normalized vectors with semantic projection", () => {
  const m = new LocalLSA([
    "кот ест рыбу",
    "собака ест мясо",
    "рыба живёт в воде",
  ]);
  const [a, b, c] = m.embed(["кот рыба", "кот рыба", "автомобиль"]);
  assert.equal(a.length, 256);
  assert(a.every(Number.isFinite));
  assert(Math.abs(cosine(a, b) - 1) < 1e-8);
  assert.equal(cosine(c, c), 0);
});
test("dataset has stratified deterministic 48/12 split and isolated unknown questions", async () => {
  const all = await dataset();
  assert.equal(all.length, 60);
  assert.equal(all.filter((c) => c.split === "dev").length, 48);
  assert.equal(all.filter((c) => c.split === "holdout").length, 12);
  for (const split of ["dev", "holdout"])
    assert(all.some((c) => c.split === split && !c.source_id));
  assert.deepEqual(splitCases(all), all);
});
test("retrieval finds AD-413 article and Team limit with source metadata", async () => {
  for (const [q, id] of [
    ["Что означает AD-413?", "AD-KB-09.03"],
    ["Сколько документов в Team?", "AD-KB-08.01"],
  ]) {
    const r = await offlineRetrieve(q, defaults());
    assert(r.sources.some((s) => s.articleId === id));
    if (q.includes("Team"))
      assert(
        r.sources.find((s) => s.articleId === id)?.content.includes("500"),
      );
  }
});
test("BM25 gives exact AD-413 code its own lexical hit and priority", async () => {
  const r = await offlineRetrieve("AD-413", defaults());
  const exact = r.bm25Results.find((s) => s.articleId === "AD-KB-09.03");
  assert(exact, "BM25 should find the precise technical code");
  assert(exact.bm25Score! > 0);
  assert.equal(exact.bm25Rank, 1);
});
test("BM25 retrieves paraphrased Russian query by stemmed terms", async () => {
  const r = await offlineRetrieve("не удается создать проект", defaults());
  assert(r.bm25Results.length > 0);
  assert(r.bm25Results.some((s) => s.bm25Score! > 0));
});
test("hybrid retrieval keeps vector and genuine BM25 rankings independent", async () => {
  const r = await offlineRetrieve("Что означает AD-413?", defaults());
  assert(r.vectorResults.length > 0);
  assert(r.bm25Results.length > 0);
  assert(r.sources.length > 0);
  assert(r.sources.some((s) => s.vectorRank != null && s.bm25Rank != null));
});
test("hybrid diagnostics expose intersection independently of fused results", async () => {
  const r = await offlineRetrieve("Что означает AD-413?", defaults());
  assert(r.overlapIds.length > 0);
  for (const id of r.overlapIds) {
    assert(r.vectorResults.some((s) => s.id === id));
    assert(r.bm25Results.some((s) => s.id === id));
  }
});
test("model context is the exact serialized source payload used by the prompt", async () => {
  const r = await offlineRetrieve("AD-413", defaults());
  const payload = contextForModel(r.sources);
  assert.deepEqual(
    payload,
    r.sources.map(({ id, articleId, title, section, content, position }) => ({
      id,
      articleId,
      title,
      section,
      content,
      position,
    })),
  );
  assert(
    payload.every(
      (s) => s.id && s.articleId && s.section && s.content && s.position,
    ),
  );
});
test("source citations only link to retrieved article IDs and section fragments", async () => {
  const r = await offlineRetrieve("AD-413", defaults());
  const valid = r.sources[0].articleId;
  const checked = validateCitations(
    `Факт [${valid}] и выдуманная AD-KB-99.99`,
    r.sources,
  );
  assert(checked.citations.includes(valid));
  assert(!checked.citations.includes("AD-KB-99.99"));
  assert(checked.answer.includes("[ссылка не подтверждена]"));
});
test("RAG refuses when no retrieved evidence exists; plain mode stays available", () => {
  assert(shouldRefuse(true, []));
  assert(!shouldRefuse(false, []));
});
test("all four evaluation modes carry diagnostics, and plain modes declare RAG off", async () => {
  const r = await offlineRetrieve("AD-413", defaults());
  for (const role of ["baseline", "strong"])
    for (const rag of [true, false]) {
      const mode = `${role}-${rag ? "rag" : "plain"}`;
      const diagnostics = rag
        ? r
        : { vectorResults: [], bm25Results: [], overlapIds: [] };
      assert.match(mode, /^(baseline|strong)-(rag|plain)$/);
      assert.ok(diagnostics.vectorResults.length === 0 || rag);
      assert.ok(diagnostics.bm25Results.length === 0 || rag);
    }
});
test("citation validation filters invented article links and preserves diagnostics", async () => {
  const r = await offlineRetrieve("AD-413", defaults());
  const checked = validateCitations(
    "Ответ AD-KB-09.03 и AD-KB-99.99",
    r.sources,
  );
  assert.deepEqual(checked.citations, ["AD-KB-09.03"]);
  assert.deepEqual(checked.invalidCitations, ["AD-KB-99.99"]);
  assert(!checked.answer.includes("AD-KB-99.99"));
});
test("cost is unknown without prices/usage and correct with configured prices", () => {
  const s = defaults();
  assert.equal(
    estimateCost(
      { prompt_tokens: 1000, completion_tokens: 500 },
      "baseline",
      s,
    ),
    null,
  );
  s.baselineInput = 10;
  s.baselineOutput = 20;
  assert.equal(
    estimateCost(
      { prompt_tokens: 1000, completion_tokens: 500 },
      "baseline",
      s,
    ),
    0.02,
  );
  assert.equal(estimateCost(null, "baseline", s), null);
});
test("password sessions resist tampering and expire", () => {
  const token = newSession("secret");
  assert(sessionOwner(token, "secret"));
  assert.equal(sessionOwner(token + "x", "secret"), null);
  assert.equal(sessionOwner(token, "other"), null);
  assert(passwordMatches("test", "test"));
  assert(!passwordMatches("test", "no"));
});
test("rate limit rejects over-limit calls", async () => {
  await rateLimit("unit-test", 1, 60, false);
  await assert.rejects(rateLimit("unit-test", 1, 60, false), /Слишком много/);
});
test("CSV escapes quotes, commas and formula injection", () => {
  const text = csv([{ q: '=IMPORT("a")', answer: "a,b\nc" }]);
  assert(text.includes("'=IMPORT"));
  assert(text.includes('"a,b\nc"'));
});
test("upload rejects false PDF, binary text, secrets and empty DOCX", async () => {
  for (const file of [
    new File(["fake"], "x.pdf"),
    new File(["a\0b"], "x.txt"),
    new File(["API_KEY=secret"], "x.md"),
    new File([""], "x.docx"),
  ])
    await assert.rejects(extract(file));
});
test("errors do not echo upstream secrets", () => {
  assert(!publicError(new Error("secret-key")).error.includes("secret-key"));
  assert.equal(publicError({ status: 429 }).status, 429);
});
test("quality is never fabricated from retrieval/citation scores", async () => {
  const c = (await dataset())[0];
  const m = metrics(c, {
    answer: "test",
    sources: [],
    citations: [],
    invalidCitations: [],
  });
  assert.equal(m.factualAccuracy, null);
  assert.equal(m.reviewRequired, true);
});

test("real PDF and DOCX parsers extract text in the Node runtime", async () => {
  const pdf = await extract(
    new File([await readFile("AgentDesk_Manual_35pages.pdf")], "manual.pdf"),
  );
  assert(pdf.text.includes("AgentDesk"));
  const docx = await extract(
    new File([await readFile("tests/fixtures/sample.docx")], "sample.docx"),
  );
  assert(docx.text.includes("AgentDesk: проверка DOCX."));
});
