declare module "snowball-stemmers" {
  export function newStemmer(language: string): { stem(word: string): string };
}
