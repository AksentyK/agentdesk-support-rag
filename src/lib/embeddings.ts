import { Matrix, SingularValueDecomposition } from "ml-matrix";
import { newStemmer } from "snowball-stemmers";
import { hash } from "./knowledge";
const stemmer = newStemmer("russian");
const stop = new Set(
  "что как для или это при все если когда сколько можно нужно необходимо должен должна будет есть после через только она они его без про ли не на по из со во от до за об об этом такой чтобы а и в с у к о но же бы вы мы он".split(
    " ",
  ),
);
export function tokens(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/ё/g, "е")
      .match(/ad-\d+|[\p{L}\d]+/gu) || []
  )
    .filter((w) => w.length > 1 && !stop.has(w))
    .map((w) => (/[а-я]/.test(w) ? stemmer.stem(w) : w));
}
export const DIMENSIONS = 256;
export const DEFAULT_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B";
export const DEFAULT_EMBEDDING_DIMENSIONS = 4096;
export const ROUTERAI_EMBEDDINGS_URL = "https://routerai.ru/api/v1/embeddings";
export type NeuralEmbeddingBatch = {
  model: string;
  dimensions: number;
  vectors: number[][];
};

export async function requestRouterEmbeddings(
  texts: string[],
  options: {
    apiKey: string;
    model?: string;
    expectedDimensions?: number;
    endpoint?: string;
    fetcher?: typeof fetch;
  },
): Promise<NeuralEmbeddingBatch> {
  if (!texts.length)
    return {
      model: options.model || DEFAULT_EMBEDDING_MODEL,
      dimensions: 0,
      vectors: [],
    };
  const endpoint = options.endpoint || ROUTERAI_EMBEDDINGS_URL;
  if (new URL(endpoint).protocol !== "https:")
    throw new Error("Embedding endpoint must use HTTPS.");
  const response = await (options.fetcher || fetch)(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model || DEFAULT_EMBEDDING_MODEL,
      input: texts,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok)
    throw new Error(`RouterAI embeddings request failed (${response.status}).`);
  const payload = (await response.json()) as {
    model?: string;
    data?: { index?: number; embedding?: number[] }[];
  };
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length)
    throw new Error(
      "Embedding provider returned an unexpected number of vectors.",
    );
  const ordered = [...payload.data].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  const vectors = ordered.map((item) => item.embedding);
  const dimensions = vectors[0]?.length || 0;
  if (
    !dimensions ||
    vectors.some(
      (v) =>
        !v || v.length !== dimensions || v.some((n) => !Number.isFinite(n)),
    )
  )
    throw new Error(
      "Embedding provider returned invalid or inconsistent vector dimensions.",
    );
  const expected =
    options.expectedDimensions ??
    Number(process.env.EMBEDDING_DIMENSIONS || DEFAULT_EMBEDDING_DIMENSIONS);
  if (expected && expected !== dimensions)
    throw new Error(
      `Embedding dimension mismatch: configured ${expected}, received ${dimensions}.`,
    );
  return {
    model: payload.model || options.model || DEFAULT_EMBEDDING_MODEL,
    dimensions,
    vectors: vectors as number[][],
  };
}

export async function neuralEmbeddings(
  texts: string[],
): Promise<NeuralEmbeddingBatch> {
  const apiKey = process.env.ROUTERAI_API_KEY;
  if (!apiKey)
    throw new Error("ROUTERAI_API_KEY is not configured for embeddings.");
  const expected = Number(
    process.env.EMBEDDING_DIMENSIONS || DEFAULT_EMBEDDING_DIMENSIONS,
  );
  const full: number[][] = [];
  let model = process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  let dimensions = expected;
  for (let i = 0; i < texts.length; i += 32) {
    const part = await requestRouterEmbeddings(texts.slice(i, i + 32), {
      apiKey,
      model,
      expectedDimensions: expected,
      endpoint: process.env.EMBEDDING_ENDPOINT || ROUTERAI_EMBEDDINGS_URL,
    });
    if (dimensions && part.dimensions !== dimensions)
      throw new Error("Embedding dimension changed between batches.");
    if (full.length && part.model !== model)
      throw new Error("Embedding model changed between batches.");
    model = part.model;
    dimensions = part.dimensions;
    full.push(...part.vectors);
  }
  return { model, dimensions, vectors: full };
}

export function embeddingRevision(model: string, dimensions: number) {
  return hash(`routerai:${model}:${dimensions}:v1`);
}
export interface EmbeddingAdapter {
  embed(texts: string[]): number[][];
  hash: string;
}
// Corpus-trained latent semantic analysis, never a chat completion or an API mock.
export class LocalLSA implements EmbeddingAdapter {
  readonly hash: string;
  private vocabulary: Map<string, number>;
  private idf: number[];
  private projection: Matrix;
  constructor(corpus: string[]) {
    if (!corpus.length) throw new Error("Empty embedding corpus");
    if (
      process.env.EMBEDDING_PROVIDER &&
      process.env.EMBEDDING_PROVIDER !== "local"
    )
      throw new Error("Only local LSA is supported");
    if (process.env.EMBEDDING_MODEL && process.env.EMBEDDING_MODEL !== "lsa-v1")
      throw new Error("Local adapter requires EMBEDDING_MODEL=lsa-v1");
    if (
      process.env.EMBEDDING_DIMENSIONS &&
      Number(process.env.EMBEDDING_DIMENSIONS) !== DIMENSIONS
    )
      throw new Error("Local LSA requires 256 dimensions");
    const docs = corpus.map(tokens),
      df = new Map<string, number>();
    for (const doc of docs)
      for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1);
    const terms = [...df.keys()].sort();
    this.vocabulary = new Map(terms.map((t, i) => [t, i]));
    this.idf = terms.map((t) => Math.log(1 + docs.length / (df.get(t) || 1)));
    const matrix = new Matrix(docs.map((d) => this.tfidf(d)));
    const svd = new SingularValueDecomposition(matrix, { autoTranspose: true });
    this.projection = svd.rightSingularVectors.subMatrix(
      0,
      terms.length - 1,
      0,
      Math.min(63, svd.rightSingularVectors.columns - 1),
    );
    this.hash = hash("lsa-v1:256:" + corpus.join("\n"));
  }
  private tfidf(ts: string[]) {
    const row = Array(this.vocabulary.size).fill(0) as number[];
    for (const t of ts) {
      const i = this.vocabulary.get(t);
      if (i !== undefined) row[i]++;
    }
    return row.map((n, i) => (n ? (1 + Math.log(n)) * this.idf[i] : 0));
  }
  embed(texts: string[]) {
    return texts.map((text) => {
      const v = new Matrix([this.tfidf(tokens(text))])
        .mmul(this.projection)
        .getRow(0);
      const norm = Math.hypot(...v) || 1;
      const vector = v.map((n) => n / norm);
      while (vector.length < DIMENSIONS) vector.push(0);
      if (
        vector.length !== DIMENSIONS ||
        vector.some((n) => !Number.isFinite(n))
      )
        throw new Error("Invalid embedding dimensions");
      return vector;
    });
  }
}
export function cosine(a: number[], b: number[]) {
  return a.reduce((sum, n, i) => sum + n * b[i], 0);
}
let cached: { key: string; adapter: LocalLSA } | undefined;
export function adapter(corpus: string[]) {
  const key = hash(corpus.join("\n"));
  if (cached?.key !== key) cached = { key, adapter: new LocalLSA(corpus) };
  return cached.adapter;
}
