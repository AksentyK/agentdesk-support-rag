import { dataset } from "../src/lib/dataset";
import { offlineRetrieve } from "../src/lib/retrieval";
import { defaults } from "../src/lib/settings";
async function main() {
  const split = process.argv.includes("--holdout") ? "holdout" : "dev";
  const cases = (await dataset()).filter((c) => c.split === split);
  let hits = 0,
    positive = 0,
    refusals = 0,
    negative = 0;
  for (const c of cases) {
    const r = await offlineRetrieve(c.question, defaults());
    if (c.source_id) {
      positive++;
      if (r.sources.some((s) => s.articleId === c.source_id)) hits++;
    } else {
      negative++;
      if (!r.sources.length) refusals++;
    }
  }
  console.log(
    JSON.stringify(
      {
        split,
        cases: cases.length,
        retrievalHits: hits,
        answerable: positive,
        hitAt5: hits / positive,
        emptyRetrievalForOutOfScope: refusals,
        outOfScope: negative,
        note: "Retrieval only; no generation or factual accuracy measurement",
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
