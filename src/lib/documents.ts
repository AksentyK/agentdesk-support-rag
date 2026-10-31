import { AppError } from "./errors";
import path from "node:path";
export async function extract(file: File) {
  if (file.size > 20 * 1024 * 1024)
    throw new AppError(413, "Максимальный размер файла — 20 МБ.");
  const name = path
    .basename(file.name)
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .slice(0, 160);
  const ext = path.extname(name).toLowerCase(),
    buffer = Buffer.from(await file.arrayBuffer());
  let text: string;
  if (ext === ".pdf") {
    if (buffer.subarray(0, 5).toString() !== "%PDF-")
      throw new AppError(400, "Содержимое не является PDF.");
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo();
      if (info.total > 200) throw new AppError(413, "Максимум 200 страниц.");
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else if (ext === ".docx") {
    if (buffer.length < 4 || buffer.readUInt16LE(0) !== 0x4b50)
      throw new AppError(400, "Содержимое не является DOCX.");
    // Bound ZIP expansion before handing it to the parser.
    let expanded = 0;
    for (let i = 0; i + 46 < buffer.length; i++) {
      if (buffer.readUInt32LE(i) === 0x02014b50)
        expanded += buffer.readUInt32LE(i + 24);
    }
    if (expanded > 50 * 1024 * 1024)
      throw new AppError(413, "DOCX слишком велик после распаковки.");
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (ext === ".md" || ext === ".txt") {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (text.includes("\0")) throw new AppError(400, "Ожидается текст UTF-8.");
  } else
    throw new AppError(415, "Поддерживаются MD, TXT, PDF с текстом и DOCX.");
  if (text.length > 2_000_000)
    throw new AppError(413, "Слишком много извлечённого текста.");
  if (
    /(?:sk-[a-zA-Z0-9]{20,}|-----BEGIN .*PRIVATE KEY|(?:API_KEY|PASSWORD)\s*=\s*\S+)/i.test(
      text,
    )
  )
    throw new AppError(
      400,
      "Документ похож на файл с секретами. Удалите секреты перед загрузкой.",
    );
  return { name, text };
}
