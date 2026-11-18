import { randomUUID } from "node:crypto";
import { db } from "./db";
import { executeRun } from "./evaluation";
import { AppError } from "./errors";

// Longer than a 300s function. Expiry fences late writes and never resends AI calls.
export async function reconcileStaleRuns() {
  await db().evaluationRun.updateMany({
    where: {
      executor: "workflow",
      status: { in: ["queued", "running"] },
      leaseExpiresAt: { lt: new Date() },
    },
    data: { status: "interrupted", leaseToken: null, leaseExpiresAt: null },
  });
}
export async function executeWorkflowBatch(id: string, batch: number) {
  const token = randomUUID();
  const claimed = await db().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "EvaluationRun" WHERE id=${id} FOR UPDATE`;
    const run = await tx.evaluationRun.findUniqueOrThrow({ where: { id } });
    if (
      run.executor !== "workflow" ||
      !["queued", "running"].includes(run.status)
    )
      return "stop";
    if (run.cancelled) {
      await tx.evaluationRun.update({
        where: { id },
        data: { status: "cancelled" },
      });
      return "stop";
    }
    if (run.nextBatch > batch) return "done";
    // Duplicate delivery of an uncertain in-flight batch must never resend a paid request.
    if (run.nextBatch !== batch || run.leaseToken)
      throw new AppError(409, "Пакет уже исполняется или требует проверки.");
    await tx.evaluationRun.update({
      where: { id },
      data: {
        status: "running",
        leaseToken: token,
        leaseExpiresAt: new Date(Date.now() + 360000),
      },
    });
    return "claimed";
  });
  if (claimed === "stop") return false;
  if (claimed === "done") return true;
  const more = await executeRun(id, { oneBatch: true, leaseToken: token });
  await db().evaluationRun.updateMany({
    where: { id, leaseToken: token },
    data: {
      nextBatch: { increment: 1 },
      leaseToken: null,
      leaseExpiresAt: more ? new Date(Date.now() + 600000) : null,
    },
  });
  return Boolean(more);
}
export async function interruptWorkflowRun(id: string) {
  await db().evaluationRun.updateMany({
    where: {
      id,
      executor: "workflow",
      status: { in: ["queued", "running", "interrupted"] },
    },
    data: { status: "interrupted", leaseToken: null, leaseExpiresAt: null },
  });
}
