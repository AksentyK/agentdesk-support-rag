import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { extract } from "./documents";
import { importDocument } from "./retrieval";
export const UPLOAD_PART_SIZE = 3 * 1024 * 1024;
export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;
const uploadSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(160)
    .regex(/\.(md|txt|pdf|docx)$/i),
  size: z.number().int().min(1).max(MAX_UPLOAD_SIZE),
});
export async function beginUpload(owner: string, input: unknown) {
  const { name, size } = uploadSchema.parse(input);
  return db().$transaction(async (tx) => {
    await tx.documentUpload.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    // One bounded temporary file per session, replacing any abandoned upload.
    await tx.documentUpload.deleteMany({ where: { owner } });
    return tx.documentUpload.create({
      data: {
        owner,
        name,
        size,
        expiresAt: new Date(Date.now() + 30 * 60000),
      },
      select: { id: true },
    });
  });
}
async function findUpload(id: string, owner: string) {
  const upload = await db().documentUpload.findFirst({
    where: { id, owner, expiresAt: { gt: new Date() } },
  });
  if (!upload)
    throw new AppError(
      404,
      "Загрузка не найдена или истекла. Выберите файл повторно.",
    );
  return upload;
}
export async function putUploadPart(
  id: string,
  owner: string,
  index: number,
  data: Uint8Array,
) {
  const upload = await findUpload(id, owner);
  const count = Math.ceil(upload.size / UPLOAD_PART_SIZE);
  const expected = Math.min(
    UPLOAD_PART_SIZE,
    upload.size - index * UPLOAD_PART_SIZE,
  );
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count ||
    data.length !== expected
  )
    throw new AppError(400, "Неверный размер или номер части файла.");
  await db().documentUploadPart.upsert({
    where: { uploadId_index: { uploadId: id, index } },
    create: { uploadId: id, index, data: Buffer.from(data) },
    update: { data: Buffer.from(data) },
  });
}
export async function finishUpload(id: string, owner: string) {
  const upload = await findUpload(id, owner);
  const parts = await db().documentUploadPart.findMany({
    where: { uploadId: id },
    orderBy: { index: "asc" },
  });
  if (
    parts.length !== Math.ceil(upload.size / UPLOAD_PART_SIZE) ||
    parts.some((p, i) => p.index !== i) ||
    parts.reduce((n, p) => n + p.data.length, 0) !== upload.size
  )
    throw new AppError(409, "Загружены не все части файла.");
  const extracted = await extract(
    new File(
      [Buffer.concat(parts.map((p) => Buffer.from(p.data)))],
      upload.name,
    ),
  );
  const document = await importDocument(extracted.name, extracted.text);
  await db().documentUpload.deleteMany({ where: { id, owner } });
  return document;
}
