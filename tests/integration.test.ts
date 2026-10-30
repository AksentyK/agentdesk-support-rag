import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { db } from "../src/lib/db";
import { bundledKnowledge } from "../src/lib/knowledge";
import { corpus, importDocument, retrieve } from "../src/lib/retrieval";
import { defaults } from "../src/lib/settings";
import { answer, catalog } from "../src/lib/router";
import { createRun, executeRun } from "../src/lib/evaluation";
import { publicError } from "../src/lib/errors";
const enabled = Boolean(process.env.DATABASE_URL);
after(async () => {
  if (enabled) await db().$disconnect();
});
test(
  "real PostgreSQL/pgvector: idempotent index, similarity search and durable evaluation",
  { skip: !enabled },
  async () => {
    const text = await bundledKnowledge();
    await importDocument("AgentDesk_Knowledge.md", text);
    const before = await db().chunk.count();
    await importDocument("AgentDesk_Knowledge.md", text);
    assert.equal(await db().chunk.count(), before);
    const rows = await corpus();
    assert(rows.length >= 35);
    assert.equal(
      await db().document.count({ where: { name: "AgentDesk_Knowledge.md" } }),
      1,
    );
    for (const [q, id] of [
      ["Что означает AD-413?", "AD-KB-09.03"],
      ["Сколько документов в Team?", "AD-KB-08.01"],
    ])
      assert(
        (await retrieve(q, defaults())).sources.some((s) => s.articleId === id),
      );
    const run = await createRun(
      "integration",
      "dev",
      "retrieval",
      defaults(),
      0,
    );
    await db().evaluationRun.update({
      where: { id: run.id },
      data: { status: "running" },
    });
    await executeRun(run.id);
    const completed = await db().evaluationRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { results: true },
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.completed, 48);
    assert.equal(completed.results.length, 48);
    assert(completed.results.every((r) => r.status === "ok"));
  },
);
test(
  "mock RouterAI HTTP API: catalog, all four modes, usage and 401/429/500 redaction",
  { skip: !enabled },
  async () => {
    let upstreamStatus = 200,
      calls = 0;
    const observed: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/models")) {
        res.end(
          JSON.stringify({
            data: [{ id: "mock/baseline" }, { id: "mock/strong" }],
          }),
        );
        return;
      }
      calls++;
      let raw = "";
      for await (const part of req) raw += part;
      observed.push(JSON.parse(raw));
      if (upstreamStatus !== 200) {
        res.writeHead(upstreamStatus);
        res.end(
          JSON.stringify({ error: { message: "do-not-expose-secret-key" } }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          id: "mock",
          choices: [
            {
              message: {
                role: "assistant",
                content: "AD-413: файл больше предела тарифа. AD-KB-09.03",
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 30,
            total_tokens: 130,
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const saved = {
      key: process.env.ROUTERAI_API_KEY,
      url: process.env.ROUTERAI_BASE_URL,
      node: process.env.NODE_ENV,
    };
    Object.assign(process.env, { NODE_ENV: "test" });
    process.env.ROUTERAI_API_KEY = "mock-only-test-key";
    process.env.ROUTERAI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
    const s = {
      ...defaults(),
      baseline: "mock/baseline",
      strong: "mock/strong",
      baselineInput: 10,
      baselineOutput: 20,
      strongInput: 30,
      strongOutput: 40,
    };
    try {
      assert.equal((await catalog()).length, 2);
      for (const role of ["baseline", "strong"] as const)
        for (const rag of [false, true]) {
          const r = await answer("Что означает AD-413?", role, rag, s);
          assert.equal(r.usage?.total_tokens, 130);
          assert(r.cost! > 0);
          assert.equal(r.sources.length > 0, rag);
          assert.equal(r.citations.includes("AD-KB-09.03"), rag);
        }
      assert.equal(calls, 4);
      assert.equal(
        JSON.stringify(observed).includes("reference_answer"),
        false,
      );
      assert(observed.every((r) => r.temperature === 0.2));
      for (const status of [401, 429, 500]) {
        upstreamStatus = status;
        try {
          await answer("AD-413", "baseline", false, s);
          assert.fail("should fail");
        } catch (e) {
          assert(!publicError(e).error.includes("do-not-expose"));
        }
      }
      assert.equal(calls, 7, "upstream failures must not be silently retried");
      const before = calls;
      const refusal = await answer("qqqunknownword", "baseline", true, {
        ...s,
        threshold: 1,
      });
      assert.equal(refusal.status, "refused-no-source");
      assert.equal(calls, before);
    } finally {
      for (const [key, value] of [
        ["ROUTERAI_API_KEY", saved.key],
        ["ROUTERAI_BASE_URL", saved.url],
        ["NODE_ENV", saved.node],
      ]) {
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
