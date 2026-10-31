import { readFile } from "node:fs/promises";
import { hash } from "./knowledge";
export type TestCase = {
  id: string;
  question: string;
  reference_answer: string;
  source_id: string;
  category: string;
  expected_action: string;
  split: "dev" | "holdout";
};
export function splitCases(cases: Omit<TestCase, "split">[]): TestCase[] {
  // Fixed seed, stratified independently of question/reference content.
  const ranked = (xs: typeof cases) =>
    [...xs].sort((a, b) =>
      hash("agentdesk-v1:" + a.id).localeCompare(hash("agentdesk-v1:" + b.id)),
    );
  const holdout = new Set(
    [
      ...ranked(cases.filter((c) => !c.source_id)).slice(0, 2),
      ...ranked(cases.filter((c) => c.source_id)).slice(0, 10),
    ].map((c) => c.id),
  );
  return cases.map((c) => ({
    ...c,
    split: holdout.has(c.id) ? "holdout" : "dev",
  }));
}
export async function dataset() {
  return splitCases(JSON.parse(await readFile("RAG_Test_Cases.json", "utf8")));
}
export function datasetHash(cases: TestCase[]) {
  return hash(JSON.stringify(cases));
}
