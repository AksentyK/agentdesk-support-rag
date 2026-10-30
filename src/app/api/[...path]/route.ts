import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError, publicError } from "@/lib/errors";
import {
  passwordMatches,
  newSession,
  sessionOwner,
  rateLimit,
} from "@/lib/auth";
import { settings, settingsSchema } from "@/lib/settings";
import { catalog, validateModels, answer } from "@/lib/router";
import { bundledKnowledge, articles } from "@/lib/knowledge";
import {
  corpus,
  importDocument,
  reindexAll,
  offlineRetrieve,
  retrieve,
} from "@/lib/retrieval";
import { extract } from "@/lib/documents";
import { dataset } from "@/lib/dataset";
import { createRun, csv } from "@/lib/evaluation";
import { modelReadiness, checkStartupModels } from "@/lib/readiness";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function bounded(req: NextRequest, max: number) {
  if (Number(req.headers.get("content-length")) > max)
    throw new AppError(413, "Слишком большой запрос.");
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel();
      throw new AppError(413, "Слишком большой запрос.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function body(req: NextRequest) {
  const bytes = await bounded(req, 65536);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError(400, "Некорректный JSON.");
  }
}
async function handler(req: NextRequest) {
  try {
    const path = req.nextUrl.pathname.replace(/^\/api\//, ""),
      method = req.method,
      password = process.env.DEMO_ACCESS_PASSWORD;
    if (method !== "GET") {
      const origin = req.headers.get("origin");
      if (
        origin &&
        (process.env.APP_ORIGIN
          ? origin !== process.env.APP_ORIGIN
          : new URL(origin).host !== req.headers.get("host"))
      )
        throw new AppError(403, "Запрос с другого сайта запрещён.");
    }
    if (path === "health") {
      let database = false,
        indexed = false;
      try {
        await db().$queryRaw`SELECT 1`;
        database = true;
        indexed = (await db().chunk.count()) > 0;
      } catch {}
      return json(
        {
          app: "ok",
          database,
          indexed,
          routerKeyConfigured: Boolean(process.env.ROUTERAI_API_KEY),
          models: modelReadiness,
        },
        database ? 200 : 503,
      );
    }
    if (path === "auth/status")
      return json({
        authenticated: password
          ? Boolean(
              sessionOwner(
                req.cookies.get("agentdesk_session")?.value,
                password,
              ),
            )
          : process.env.NODE_ENV !== "production",
        passwordConfigured: Boolean(password),
      });
    if (path === "auth/login" && method === "POST") {
      if (!password) throw new AppError(503, "DEMO_ACCESS_PASSWORD не задан.");
      await rateLimit("login:global", 10, 60, false);
      const data = z
        .object({ password: z.string().max(512) })
        .parse(await body(req));
      if (!passwordMatches(data.password, password))
        throw new AppError(401, "Неверный пароль.");
      const response = json({ ok: true });
      response.cookies.set("agentdesk_session", newSession(password), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 43200,
        path: "/",
      });
      return response;
    }
    if (path === "auth/logout" && method === "POST") {
      const response = json({ ok: true });
      response.cookies.delete("agentdesk_session");
      return response;
    }
    const owner = password
      ? sessionOwner(req.cookies.get("agentdesk_session")?.value, password)
      : process.env.NODE_ENV !== "production"
        ? "local-development"
        : null;
    if (!owner)
      throw new AppError(
        401,
        password
          ? "Войдите по паролю."
          : "Production заблокирован: задайте DEMO_ACCESS_PASSWORD.",
      );
    if (method !== "GET") await rateLimit("mutations:" + owner, 60);
    if (path === "settings" && method === "GET")
      return json({
        settings: await settings(),
        keyConfigured: Boolean(process.env.ROUTERAI_API_KEY),
        databaseConfigured: Boolean(process.env.DATABASE_URL),
      });
    if (path === "settings" && method === "PUT") {
      const s = settingsSchema.parse(await body(req));
      if (s.baseline || s.strong) await validateModels(s);
      await db().modelConfig.upsert({
        where: { id: "default" },
        create: { value: s },
        update: { value: s },
      });
      await db().pricingSnapshot.create({ data: { value: s } });
      await checkStartupModels();
      return json({ ok: true });
    }
    if (path === "models") return json({ models: await catalog() });
    if (path === "articles")
      return json({ articles: articles(await bundledKnowledge()) });
    if (path === "search" && method === "POST") {
      const data = z
        .object({
          question: z.string().min(2).max(2000),
          offline: z.boolean().default(false),
        })
        .parse(await body(req));
      const s = await settings();
      return json(
        await (data.offline
          ? offlineRetrieve(data.question, s)
          : retrieve(data.question, s)),
      );
    }
    if (path === "chat" && method === "POST") {
      await rateLimit("chat:" + owner, 20);
      const data = z
        .object({
          question: z.string().min(1).max(4000),
          role: z.enum(["baseline", "strong"]),
          rag: z.boolean(),
          sessionId: z.string().uuid().optional(),
        })
        .parse(await body(req));
      const prisma = db();
      let session = data.sessionId
        ? await prisma.chatSession.findFirst({
            where: { id: data.sessionId, owner },
            include: { messages: { orderBy: { createdAt: "desc" }, take: 10 } },
          })
        : null;
      if (data.sessionId && !session)
        throw new AppError(404, "Сессия не найдена.");
      if (!session)
        session = {
          ...(await prisma.chatSession.create({ data: { owner } })),
          messages: [],
        };
      const history = session.messages.toReversed().map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
      const result = await answer(
        data.question,
        data.role,
        data.rag,
        await settings(),
        history,
      );
      await prisma.message.createMany({
        data: [
          {
            sessionId: session.id,
            role: "user",
            content: data.question,
            createdAt: new Date(),
          },
          {
            sessionId: session.id,
            role: "assistant",
            content: result.answer,
            createdAt: new Date(Date.now() + 1),
            diagnostics: result as unknown as Prisma.InputJsonValue,
          },
        ],
      });
      return json({ ...result, sessionId: session.id });
    }
    if (path === "documents" && method === "GET")
      return json({
        documents: await db().document.findMany({
          include: {
            versions: {
              where: { active: true },
              include: { _count: { select: { chunks: true } } },
            },
          },
          orderBy: { createdAt: "desc" },
        }),
      });
    if (path === "documents/import" && method === "POST") {
      if (
        await db().evaluationRun.count({
          where: { status: { in: ["queued", "running"] } },
        })
      )
        throw new AppError(409, "Дождитесь завершения теста.");
      return json(
        await importDocument(
          "AgentDesk_Knowledge.md",
          await bundledKnowledge(),
        ),
      );
    }
    if (path === "documents" && method === "POST") {
      if (Number(req.headers.get("content-length")) > 21 * 1024 * 1024)
        throw new AppError(413, "Максимальный размер загрузки — 20 МБ.");
      const bytes = await bounded(req, 21 * 1024 * 1024);
      const form = await new Response(bytes, {
          headers: { "Content-Type": req.headers.get("content-type") || "" },
        }).formData(),
        file = form.get("file");
      if (!(file instanceof File)) throw new AppError(400, "Выберите файл.");
      const extracted = await extract(file);
      return json(await importDocument(extracted.name, extracted.text));
    }
    const docMatch = path.match(/^documents\/([^/]+)(\/reindex)?$/);
    if (docMatch) {
      const doc = await db().document.findUnique({
        where: { id: docMatch[1] },
        include: { versions: { where: { active: true } } },
      });
      if (!doc) throw new AppError(404, "Документ не найден.");
      if (method === "GET") return json(doc);
      if (method === "POST" && docMatch[2])
        return json(await importDocument(doc.name, doc.versions[0].text));
      if (method === "DELETE") {
        await db().$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(451392)`;
            await tx.document.delete({ where: { id: doc.id } });
            await reindexAll(tx as unknown as ReturnType<typeof db>);
          },
          { timeout: 120000 },
        );
        return json({ ok: true });
      }
    }
    if (path === "evaluation/cases") {
      const cases = await dataset();
      return json({
        cases: cases.filter((c) => c.split === "dev"),
        counts: { dev: 48, holdout: 12 },
        note: "Holdout не показывается до завершения отдельного теста.",
      });
    }
    if (path === "evaluation/runs" && method === "GET")
      return json({
        runs: await db().evaluationRun.findMany({
          where: { owner },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            status: true,
            split: true,
            kind: true,
            completed: true,
            total: true,
            createdAt: true,
          },
        }),
      });
    if (path === "evaluation/runs" && method === "POST") {
      const data = z
        .object({
          split: z.enum(["dev", "holdout", "all"]),
          kind: z.enum(["models", "retrieval"]),
          maxRequests: z.number().int().min(0).max(240),
          confirmPaid: z.boolean().default(false),
          retryId: z.string().uuid().optional(),
        })
        .parse(await body(req));
      if (data.retryId) {
        const old = await db().evaluationRun.findFirst({
          where: { id: data.retryId, owner },
        });
        if (!old) throw new AppError(404, "Тест не найден.");
        data.kind = old.kind as typeof data.kind;
        data.split = old.split as typeof data.split;
      }
      if (data.kind === "models") {
        if (!data.confirmPaid)
          throw new AppError(
            400,
            "Подтвердите расход платных запросов и лимит.",
          );
        await validateModels(await settings());
      }
      const created = await createRun(
        owner,
        data.split,
        data.kind,
        await settings(),
        data.maxRequests,
        data.retryId,
      );
      const { snapshot, ...safe } = created;
      void snapshot;
      return json(safe, 201);
    }
    const runMatch = path.match(
      /^evaluation\/runs\/([^/]+)(?:\/(cancel|export|review))?$/,
    );
    if (runMatch) {
      const run = await db().evaluationRun.findFirst({
        where: { id: runMatch[1], owner },
        include: { results: { orderBy: [{ caseId: "asc" }, { mode: "asc" }] } },
      });
      if (!run) throw new AppError(404, "Тест не найден.");
      if (method === "POST" && runMatch[2] === "cancel") {
        await db().evaluationRun.update({
          where: { id: run.id },
          data: {
            cancelled: true,
            status: run.status === "queued" ? "cancelled" : run.status,
          },
        });
        return json({ ok: true });
      }
      if (method === "POST" && runMatch[2] === "review") {
        const data = z
          .object({
            resultId: z.string().uuid(),
            score: z.number().int().min(0).max(1),
          })
          .parse(await body(req));
        await db().evaluationResult.updateMany({
          where: { id: data.resultId, runId: run.id },
          data: { manualScore: data.score },
        });
        return json({ ok: true });
      }
      if (runMatch[2] === "export")
        return new NextResponse(
          csv(
            run.results.map((r) => ({
              runId: run.id,
              indexHash: run.indexHash,
              datasetHash: run.datasetHash,
              caseId: r.caseId,
              mode: r.mode,
              status: r.status,
              manualScore: r.manualScore,
              ...(r.result as object),
            })),
          ),
          {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition":
                'attachment; filename="agentdesk-results.csv"',
            },
          },
        );
      // Reference answers remain server-side; completed holdout results can be reviewed, never inserted in prompts.
      const { snapshot, ...safe } = run;
      void snapshot;
      const references = ["completed", "completed-with-errors"].includes(
        run.status,
      )
        ? (await dataset())
            .filter((c) => run.results.some((r) => r.caseId === c.id))
            .map((c) => ({
              id: c.id,
              reference: c.reference_answer,
              sourceId: c.source_id,
            }))
        : [];
      return json({ ...safe, references });
    }
    throw new AppError(404, "Маршрут не найден.");
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        {
          error: "Проверьте поля запроса.",
          details: error.issues.map((i) => i.path.join(".")),
        },
        400,
      );
    const safe = publicError(error);
    return json({ error: safe.error }, safe.status);
  }
}
export const GET = handler,
  POST = handler,
  PUT = handler,
  DELETE = handler;
