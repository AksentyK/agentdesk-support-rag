import { z } from "zod";
import { db } from "./db";
import type { Settings } from "./types";
const price = z.number().min(0).max(1e9).nullable();
export const settingsSchema = z.object({
  baseline: z.string().max(160),
  strong: z.string().max(160),
  topK: z.number().int().min(1).max(10),
  threshold: z.number().min(0).max(1),
  semanticWeight: z.number().min(0).max(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(32).max(4000),
  currency: z.enum(["RUB", "USD", "EUR"]),
  baselineInput: price,
  baselineOutput: price,
  strongInput: price,
  strongOutput: price,
  pricingDate: z.string().max(40),
});
const optionalNumber = (name: string) =>
  process.env[name]?.trim() ? Number(process.env[name]) : null;
export function defaults(): Settings {
  return settingsSchema.parse({
    baseline: process.env.BASELINE_MODEL_ID || "",
    strong: process.env.STRONG_MODEL_ID || "",
    topK: Number(process.env.RAG_TOP_K || 5),
    threshold: Number(process.env.RAG_MIN_SCORE || 0.18),
    semanticWeight: Number(process.env.RAG_SEMANTIC_WEIGHT || 0.65),
    temperature: Number(process.env.MODEL_TEMPERATURE || 0.2),
    maxTokens: Number(process.env.MAX_OUTPUT_TOKENS || 800),
    currency: process.env.PRICING_CURRENCY || "RUB",
    baselineInput: optionalNumber("BASELINE_INPUT_PRICE_PER_1M"),
    baselineOutput: optionalNumber("BASELINE_OUTPUT_PRICE_PER_1M"),
    strongInput: optionalNumber("STRONG_INPUT_PRICE_PER_1M"),
    strongOutput: optionalNumber("STRONG_OUTPUT_PRICE_PER_1M"),
    pricingDate: process.env.PRICING_DATE || "",
  });
}
export async function settings(): Promise<Settings> {
  if (!process.env.DATABASE_URL) return defaults();
  const row = await db().modelConfig.findUnique({ where: { id: "default" } });
  return row ? settingsSchema.parse(row.value) : defaults();
}
export function estimateCost(
  usage: { prompt_tokens: number; completion_tokens: number } | null,
  role: "baseline" | "strong",
  s: Settings,
) {
  const input = s[`${role}Input`],
    output = s[`${role}Output`];
  return !usage || input === null || output === null
    ? null
    : (usage.prompt_tokens * input + usage.completion_tokens * output) / 1e6;
}
