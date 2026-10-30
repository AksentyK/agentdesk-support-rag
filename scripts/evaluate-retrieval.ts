import { createRun, executeRun } from "../src/lib/evaluation";
import { db } from "../src/lib/db";
import { defaults } from "../src/lib/settings";
import { dataset } from "../src/lib/dataset";
async function main() {
  const run = await createRun(
    "cli-validation",
    "all",
    "retrieval",
    defaults(),
    0,
  );
  await db().evaluationRun.update({
    where: { id: run.id },
    data: { status: "running" },
  });
  await executeRun(run.id);
  const results = await db().evaluationResult.findMany({
      where: { runId: run.id },
    }),
    cases = await dataset();
  const summary = ["dev", "holdout"].map((split) => {
    const selected = results.filter(
      (r) => cases.find((c) => c.id === r.caseId)?.split === split,
    );
    const answerable = selected.filter(
      (r) =>
        (r.result as { retrievalHit: boolean | null }).retrievalHit !== null,
    );
    return {
      split,
      cases: selected.length,
      passedOperations: selected.filter((r) => r.status === "ok").length,
      retrievalHits: answerable.filter(
        (r) => (r.result as { retrievalHit: boolean }).retrievalHit,
      ).length,
      answerable: answerable.length,
      outOfScopeFalsePositives: selected.filter(
        (r) =>
          (r.result as { unexpectedRetrieval: boolean }).unexpectedRetrieval,
      ).length,
    };
  });
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        indexHash: run.indexHash,
        datasetHash: run.datasetHash,
        summary,
        note: "Final retrieval validation only. No model calls or factual accuracy claims.",
      },
      null,
      2,
    ),
  );
  if (results.length !== 60 || results.some((r) => r.status !== "ok"))
    process.exitCode = 1;
}
main()
  .catch(() => {
    console.error(
      "Retrieval evaluation failed; check database, seed and active runs",
    );
    process.exitCode = 1;
  })
  .finally(() => db().$disconnect());
