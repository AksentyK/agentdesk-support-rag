import { Prisma } from "@prisma/client";
import { db } from "./db";
import { dataset, datasetHash, type TestCase } from "./dataset";
import { hash } from "./knowledge";
import { corpus, retrieve } from "./retrieval";
import { answer } from "./router";
import { publicError, AppError } from "./errors";
import type { Settings, Role, Answer } from "./types";
export const modes = [
  "baseline-plain",
  "baseline-rag",
  "strong-plain",
  "strong-rag",
];
export type Task = { caseId: string; mode: string };
export type Snapshot = { settings: Settings; tasks: Task[]; cases: TestCase[] };
export function metrics(
  c: TestCase,
  result: Pick<Answer, "answer" | "sources" | "citations" | "invalidCitations">,
) {
  const refusal =
    /(нет.{0,35}(данных|источник|информац)|не описан|не подтвержд|не могу подтверд|недостаточно|отсутств|не содержит)/i.test(
      result.answer,
    );
  return {
    retrievalHit: c.source_id
      ? result.sources.some((s) => s.articleId === c.source_id)
      : null,
    correctRefusal: !c.source_id ? refusal : null,
    citationHit: c.source_id ? result.citations.includes(c.source_id) : null,
    invalidCitationCount: result.invalidCitations.length,
    factualAccuracy: null,
    reviewRequired: true,
  };
}
export async function createRun(
  owner: string,
  split: string,
  kind: string,
  s: Settings,
  maxRequests: number,
  retryId?: string,
) {
  const all = await dataset(),
    cases = all.filter((c) => split === "all" || c.split === split);
  const rows = await corpus();
  if (!rows.length)
    throw new AppError(409, "Сначала импортируйте базу знаний.");
  const tasks: Task[] = cases.flatMap((c) =>
    (kind === "retrieval" ? ["retrieval"] : modes).map((mode) => ({
      caseId: c.id,
      mode,
    })),
  );
  let snapshot: Snapshot = { settings: s, tasks, cases };
  if (retryId) {
    const old = await db().evaluationRun.findFirst({
      where: { id: retryId, owner },
      include: { results: true },
    });
    if (!old) throw new AppError(404, "Тест не найден.");
    if (
      old.indexHash !== hash(rows.map((r) => r.checksum).join("")) ||
      old.datasetHash !== datasetHash(all)
    )
      throw new AppError(
        409,
        "Индекс или набор изменился. Запустите новый тест вместо повторения.",
      );
    snapshot = old.snapshot as unknown as Snapshot;
    const succeeded = new Set(
      old.results
        .filter((r) => r.status === "ok")
        .map((r) => r.caseId + ":" + r.mode),
    );
    snapshot = {
      ...snapshot,
      tasks: snapshot.tasks.filter(
        (t) => !succeeded.has(t.caseId + ":" + t.mode),
      ),
    };
    kind = old.kind;
    split = old.split;
  }
  if (!snapshot.tasks.length)
    throw new AppError(409, "Нет ошибок для повторного запуска.");
  if (kind === "models" && snapshot.tasks.length > maxRequests)
    throw new AppError(
      400,
      `Нужно подтвердить лимит минимум ${snapshot.tasks.length} запросов. Фактическая стоимость зависит от провайдера.`,
    );
  return db().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(451395)`;
    const active = await tx.evaluationRun.count({
      where: { status: { in: ["queued", "running"] } },
    });
    if (active)
      throw new AppError(
        409,
        "Уже выполняется тест. Дождитесь завершения или отмените его.",
      );
    const row = await tx.evaluationRun.create({
      data: {
        owner,
        split,
        kind,
        status: "queued",
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        indexHash: hash(rows.map((r) => r.checksum).join("")),
        datasetHash: datasetHash(all),
        total: snapshot.tasks.length,
      },
    });
    return row;
  });
}
export async function executeRun(id: string) {
  const run = await db().evaluationRun.findUniqueOrThrow({ where: { id } }),
    snapshot = run.snapshot as unknown as Snapshot;
  // A run is tied to one immutable corpus. Abort if documents change mid-run.
  const verifyIndex = async () => {
    const rows = await corpus();
    if (hash(rows.map((r) => r.checksum).join("")) !== run.indexHash)
      throw new AppError(
        409,
        "Индекс изменился во время теста. Запустите новый тест.",
      );
  };
  const concurrency = Math.max(
    1,
    Math.min(2, Number(process.env.MAX_PARALLEL_EVAL_REQUESTS || 2)),
  );
  const saved = await db().evaluationResult.findMany({
      where: { runId: id },
      select: { caseId: true, mode: true },
    }),
    done = new Set(saved.map((r) => r.caseId + ":" + r.mode));
  const tasks = snapshot.tasks.filter(
    (t) => !done.has(t.caseId + ":" + t.mode),
  );
  try {
    for (let i = 0; i < tasks.length; i += concurrency) {
      const fresh = await db().evaluationRun.findUniqueOrThrow({
        where: { id },
      });
      if (fresh.cancelled) {
        await db().evaluationRun.update({
          where: { id },
          data: { status: "cancelled" },
        });
        return;
      }
      await verifyIndex();
      await Promise.all(
        tasks.slice(i, i + concurrency).map(async (task) => {
          const c = snapshot.cases.find((c) => c.id === task.caseId)!;
          let result: unknown,
            status = "ok";
          try {
            if (run.kind === "retrieval") {
              const start = Date.now();
              const r = await retrieve(c.question, snapshot.settings);
              result = {
                ...r,
                ...metrics(c, {
                  answer: "",
                  sources: r.sources,
                  citations: [],
                  invalidCitations: [],
                }),
                correctRefusal: null,
                unexpectedRetrieval: !c.source_id && r.sources.length > 0,
                question: c.question,
                latencyMs: Date.now() - start,
                cost: null,
                usage: null,
              };
            } else {
              const [role, variant] = task.mode.split("-");
              const r = await answer(
                c.question,
                role as Role,
                variant === "rag",
                snapshot.settings,
              );
              result = { ...r, ...metrics(c, r), question: c.question };
            }
            await verifyIndex();
          } catch (e) {
            status = "error";
            result = { error: publicError(e).error, question: c.question };
          }
          await db().evaluationResult.create({
            data: {
              runId: id,
              caseId: c.id,
              mode: task.mode,
              status,
              result: result as Prisma.InputJsonValue,
            },
          });
          await db().evaluationRun.update({
            where: { id },
            data: { completed: { increment: 1 } },
          });
        }),
      );
    }
    const errors = await db().evaluationResult.count({
      where: { runId: id, status: "error" },
    });
    await db().evaluationRun.update({
      where: { id },
      data: { status: errors ? "completed-with-errors" : "completed" },
    });
  } catch (e) {
    await db().evaluationRun.update({
      where: { id },
      data: { status: "interrupted" },
    });
    throw e;
  }
}
export function csv(rows: Record<string, unknown>[]) {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const cell = (v: unknown) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+@-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  return (
    "\ufeff" +
    [
      keys.map(cell).join(","),
      ...rows.map((row) =>
        keys
          .map((k) =>
            cell(typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k]),
          )
          .join(","),
      ),
    ].join("\r\n")
  );
}
