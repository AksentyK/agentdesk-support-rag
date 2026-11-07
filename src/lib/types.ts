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
  vectorScore?: number | null;
  bm25Score?: number | null;
  vectorRank?: number | null;
  bm25Rank?: number | null;
  position?: number;
};
export type ContextFragment = Pick<
  Source,
  "id" | "articleId" | "title" | "section" | "content" | "position"
>;
export type RetrievalDiagnostics = {
  vectorResults: Source[];
  bm25Results: Source[];
  overlapIds: string[];
  excludedFromContext?: {
    id: string;
    articleId: string;
    title: string;
    reason:
      "outside_top_k" | "outside_candidate_limit" | "below_relevance_threshold";
  }[];
};
export type Answer = {
  answer: string;
  model: string | null;
  mode: string;
  sources: Source[];
  retrieval: RetrievalDiagnostics;
  llmContext: ContextFragment[];
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
