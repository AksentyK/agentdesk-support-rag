import { neuralEmbeddings } from "../src/lib/embeddings";

async function main() {
  const result = await neuralEmbeddings([
    "Как восстановить доступ к AgentDesk?",
  ]);
  console.log(
    JSON.stringify({
      endpoint: process.env.EMBEDDING_ENDPOINT || "https://routerai.ru/api/v1/embeddings",
      model: result.model,
      dimensions: result.dimensions,
      vectorsReturned: result.vectors.length,
      finite: result.vectors.every((v) => v.every(Number.isFinite)),
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Embedding check failed");
  process.exitCode = 1;
});
