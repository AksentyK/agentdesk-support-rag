import { sleep } from "workflow";

// Only run IDs and booleans cross Workflow boundaries; prompts/results stay in PostgreSQL.
export async function evaluationWorkflow(id: string) {
  "use workflow";
  try {
    for (let batch = 0; await evaluationBatch(id, batch); batch++) {
      await sleep("1s");
    }
  } catch {
    await interruptEvaluation(id);
  }
}
export async function evaluationBatch(id: string, batch: number) {
  "use step";
  const { executeWorkflowBatch } = await import("../lib/evaluation-batches");
  return executeWorkflowBatch(id, batch);
}
// The provider offers no exactly-once guarantee. Never retry an ambiguous paid call.
evaluationBatch.maxRetries = 0;
async function interruptEvaluation(id: string) {
  "use step";
  const { interruptWorkflowRun } = await import("../lib/evaluation-batches");
  await interruptWorkflowRun(id);
}
