import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export type Article = { articleId: string; title: string; content: string };
export function articles(text: string): Article[] {
  const pages = text.split(/(?=^## Страница \d+\.)/m).slice(1);
  if (pages.length)
    return pages
      .map((p) => ({
        articleId: p.match(/\*\*Статья: (AD-KB-\d{2}\.\d{2})/)?.[1] ?? "",
        title: p.split("\n")[0].replace(/^## /, ""),
        content: p.replace(/<a id="p\d+"><\/a>/g, "").trim(),
      }))
      .filter((p) => p.articleId);
  return [
    {
      articleId: `DOC-${hash(text).slice(0, 12)}`,
      title: "Загруженный документ",
      content: text,
    },
  ];
}
export function chunkArticles(text: string, size = 800, overlap = 120) {
  if (size < 50 || overlap < 0 || overlap >= size)
    throw new Error("Invalid chunk settings");
  return articles(text).flatMap((article) => {
    const words = article.content.split(/\s+/);
    const result = [];
    // Conservative approximation: one Cyrillic word is about two tokens.
    const window = Math.floor(size / 2),
      back = Math.floor(overlap / 2);
    for (let i = 0, index = 0; i < words.length; i += window - back, index++) {
      const content = words.slice(i, i + window).join(" ");
      result.push({
        ...article,
        content,
        index,
        section: article.title,
        checksum: hash(content),
      });
      if (i + window >= words.length) break;
    }
    return result;
  });
}
export async function bundledKnowledge() {
  return readFile(path.join(process.cwd(), "AgentDesk_Knowledge.md"), "utf8");
}
