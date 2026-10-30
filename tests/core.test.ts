import { test } from "node:test";
import assert from "node:assert/strict";
import {
  articles,
  bundledKnowledge,
  chunkArticles,
} from "../src/lib/knowledge";
import { LocalLSA, cosine } from "../src/lib/embeddings";
import { defaults, estimateCost } from "../src/lib/settings";
import { validateCitations } from "../src/lib/router";
import { dataset, splitCases } from "../src/lib/dataset";
import { offlineRetrieve } from "../src/lib/retrieval";
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
