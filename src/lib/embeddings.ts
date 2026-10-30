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
