import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { db } from "../src/lib/db";
import { bundledKnowledge } from "../src/lib/knowledge";
import { corpus, importDocument, retrieve } from "../src/lib/retrieval";
import { defaults } from "../src/lib/settings";
import { answer, catalog } from "../src/lib/router";
import { createRun, executeRun } from "../src/lib/evaluation";
import {
  executeWorkflowBatch,
  reconcileStaleRuns,
} from "../src/lib/evaluation-batches";
import {
  beginUpload,
  putUploadPart,
  finishUpload,
  UPLOAD_PART_SIZE,
} from "../src/lib/uploads";
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
      upstreamStatus = 200;
      const previousExecutor = process.env.EVALUATION_EXECUTOR;
      process.env.EVALUATION_EXECUTOR = "workflow";
      try {
        const run = await createRun("workflow-mock", "all", "models", s, 240);
        const initial = calls;
        assert.equal(await executeWorkflowBatch(run.id, 0), true);
        assert.equal(calls, initial + 2);
        assert.equal(await executeWorkflowBatch(run.id, 0), true);
        assert.equal(
          calls,
          initial + 2,
          "duplicate batch must not repeat AI requests",
        );
        for (
          let batch = 1;
          await executeWorkflowBatch(run.id, batch);
          batch++
        ) {}
        const completed = await db().evaluationRun.findUniqueOrThrow({
          where: { id: run.id },
          include: { results: true },
        });
        assert.equal(completed.status, "completed");
        assert.equal(completed.completed, 240);
        assert.equal(completed.results.length, 240);
        assert.equal(calls, initial + 240);
        assert.equal(await executeWorkflowBatch(run.id, 120), false);
      } finally {
        if (previousExecutor === undefined)
          delete process.env.EVALUATION_EXECUTOR;
        else process.env.EVALUATION_EXECUTOR = previousExecutor;
      }
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

test(
  "workflow cancellation, uncertain batches and stale leases never automatically resend work",
  { skip: !enabled },
  async () => {
    const previousExecutor = process.env.EVALUATION_EXECUTOR;
    process.env.EVALUATION_EXECUTOR = "workflow";
    try {
      const run = await createRun(
        "workflow-recovery",
        "dev",
        "retrieval",
        defaults(),
        0,
      );
      await db().evaluationRun.update({
        where: { id: run.id },
        data: {
          status: "running",
          leaseToken: "uncertain",
          leaseExpiresAt: new Date(Date.now() + 360000),
        },
      });
      await assert.rejects(executeWorkflowBatch(run.id, 0), /уже исполняется/);
      assert.equal(
        await db().evaluationResult.count({ where: { runId: run.id } }),
        0,
      );
      await db().evaluationRun.update({
        where: { id: run.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });
      await reconcileStaleRuns();
      assert.equal(await executeWorkflowBatch(run.id, 0), false);
      assert.equal(
        (await db().evaluationRun.findUniqueOrThrow({ where: { id: run.id } }))
          .status,
        "interrupted",
      );
      const retry = await createRun(
        "workflow-recovery",
        "dev",
        "retrieval",
        defaults(),
        0,
        run.id,
      );
      await executeWorkflowBatch(retry.id, 0);
      await db().evaluationRun.update({
        where: { id: retry.id },
        data: { cancelled: true },
      });
      assert.equal(await executeWorkflowBatch(retry.id, 1), false);
      const cancelled = await db().evaluationRun.findUniqueOrThrow({
        where: { id: retry.id },
      });
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.completed, 2);
      const remaining = await createRun(
        "workflow-recovery",
        "dev",
        "retrieval",
        defaults(),
        0,
        retry.id,
      );
      assert.equal(
        remaining.total,
        46,
        "explicit retry skips the two saved successful results",
      );
      for (
        let batch = 0;
        await executeWorkflowBatch(remaining.id, batch);
        batch++
      ) {}
      assert.equal(
        (
          await db().evaluationRun.findUniqueOrThrow({
            where: { id: remaining.id },
          })
        ).completed,
        46,
      );
    } finally {
      if (previousExecutor === undefined)
        delete process.env.EVALUATION_EXECUTOR;
      else process.env.EVALUATION_EXECUTOR = previousExecutor;
    }
  },
);
test(
  "multipart upload preserves a file larger than Vercel's request limit and enforces ownership, expiry and part sizes",
  { skip: !enabled },
  async () => {
    const bytes = Buffer.from("文".repeat(1700000)); // 5.1 MB, within the extracted text limit.
    const upload = await beginUpload("upload-test", {
      name: "multipart-test.txt",
      size: bytes.length,
    });
    try {
      await assert.rejects(
        putUploadPart(
          upload.id,
          "other-owner",
          0,
          bytes.subarray(0, UPLOAD_PART_SIZE),
        ),
        /не найдена/,
      );
      await assert.rejects(
        putUploadPart(upload.id, "upload-test", 0, new Uint8Array(1)),
        /размер/,
      );
      await assert.rejects(
        finishUpload(upload.id, "upload-test"),
        /не все части/,
      );
      for (
        let offset = 0, i = 0;
        offset < bytes.length;
        offset += UPLOAD_PART_SIZE, i++
      ) {
        const part = bytes.subarray(offset, offset + UPLOAD_PART_SIZE);
        await putUploadPart(upload.id, "upload-test", i, part);
        await putUploadPart(upload.id, "upload-test", i, part); // idempotent part retry
      }
      const doc = await finishUpload(upload.id, "upload-test");
      const version = await db().documentVersion.findFirstOrThrow({
        where: { documentId: doc.id, active: true },
      });
      assert.equal(version.text, bytes.toString());
      assert.equal(
        await db().documentUploadPart.count({ where: { uploadId: upload.id } }),
        0,
      );
    } finally {
      const doc = await db().document.findUnique({
        where: { name: "multipart-test.txt" },
      });
      if (doc) await db().document.delete({ where: { id: doc.id } });
      await importDocument("AgentDesk_Knowledge.md", await bundledKnowledge());
    }
    const expired = await beginUpload("upload-test", {
      name: "expired.txt",
      size: 1,
    });
    await db().documentUpload.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(0) },
    });
    await assert.rejects(
      putUploadPart(expired.id, "upload-test", 0, new Uint8Array(1)),
      /истекла/,
    );
    await assert.rejects(
      beginUpload("upload-test", {
        name: "huge.txt",
        size: 20 * 1024 * 1024 + 1,
      }),
    );
  },
);
