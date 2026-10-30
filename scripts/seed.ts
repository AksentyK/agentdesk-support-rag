import { db } from "../src/lib/db";
import { bundledKnowledge } from "../src/lib/knowledge";
import { importDocument } from "../src/lib/retrieval";
import { dataset } from "../src/lib/dataset";
async function main() {
  await importDocument("AgentDesk_Knowledge.md", await bundledKnowledge());
  for (const c of await dataset())
    await db().evaluationCase.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        question: c.question,
        referenceAnswer: c.reference_answer,
        sourceId: c.source_id,
        category: c.category,
        expectedAction: c.expected_action,
        split: c.split,
      },
      update: {},
    });
  console.log("KB indexed; 60 evaluation cases imported");
}
main()
  .catch(() => {
    console.error("Seed failed: check database and migrations");
    process.exitCode = 1;
  })
  .finally(() => db().$disconnect());
