export type Role = "baseline" | "strong";
export type Settings = {
  baseline: string;
  strong: string;
  topK: number;
  threshold: number;
  semanticWeight: number;
  temperature: number;
  maxTokens: number;
  currency: string;
  baselineInput: number | null;
  baselineOutput: number | null;
  strongInput: number | null;
  strongOutput: number | null;
  pricingDate: string;
};
export type Source = {
  id: string;
  articleId: string;
  title: string;
  section: string;
  content: string;
  filename: string;
  version: string;
  index: number;
  checksum: string;
  score: number;
};
export type Answer = {
  answer: string;
  model: string | null;
  mode: string;
  sources: Source[];
  citations: string[];
  invalidCitations: string[];
  latencyMs: number;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  cost: number | null;
  currency: string;
  indexHash: string;
  status: string;
  pricingSnapshot: Settings;
};
