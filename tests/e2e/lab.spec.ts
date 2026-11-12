import { test, expect } from "@playwright/test";
test("password, Russian UI, offline retrieval, document upload and persistent evaluation", async ({
  page,
  request,
}) => {
  const unauth = await request.get("/api/settings");
  expect(unauth.status()).toBe(401);
  const csrf = await request.post("/api/auth/login", {
    headers: { Origin: "https://untrusted.example" },
    data: { password: "invalid" },
  });
  expect(csrf.status()).toBe(403);
  await page.goto("/");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_DEMO_PASSWORD!);
  await page.getByRole("button", { name: "Войти в лабораторию" }).click();
  await expect(
    page.getByRole("heading", { name: "Точные ответы начинаются со знаний." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Отправить →" }),
  ).toBeDisabled();
  await page.getByLabel("Ваш вопрос").fill("Что означает AD-413?");
  await page.getByRole("button", { name: "Только поиск" }).click();
  await expect(page.locator(".diagnostics")).toContainText("AD-KB-09.03");
  await page.screenshot({
    path: "/tmp/agentdesk-lab-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "База знаний", exact: true }).click();
  await page.getByLabel("Фильтр статей").fill("AD-KB-08.01");
  await page
    .locator(".articlelist button")
    .filter({ hasText: "Страница 23." })
    .click();
  await expect(page.locator(".articletext")).toContainText("500 документов");
  await page.getByRole("button", { name: "Поиск", exact: true }).click();
  await page.getByLabel("Запрос для поиска").fill("ошибка AD-413");
  await page.getByRole("button", { name: "Найти" }).click();
  await expect(page.getByRole("region", { name: "BM25" })).toContainText("AD-KB-09.03");
  await expect(page.getByRole("region", { name: "Векторный поиск" })).toContainText("Нет результатов");
  await expect(page.getByText("Векторный поиск отключён в автономном режиме.")).toBeVisible();
  await page.getByRole("button", { name: "Диалог", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "e2e-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Документ для проверки загрузки и версий. " + "文".repeat(1700000),
    ),
  });
  await expect(
    page.locator(".docitem").filter({ hasText: "e2e-note.txt" }),
  ).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page
    .locator(".docitem")
    .filter({ hasText: "e2e-note.txt" })
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await expect(
    page.locator(".docitem").filter({ hasText: "e2e-note.txt" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Сравнение моделей" }).click();
  const createdResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/evaluation/runs") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Запустить тест" }).click();
  const created = await (await createdResponse).json();
  expect(created.snapshot).toBeUndefined();
  expect(JSON.stringify(created)).not.toContain("reference_answer");
  await expect(page.locator("progress")).toHaveAttribute("max", "48");
  await expect(page.locator("progress")).toHaveAttribute("value", "48", {
    timeout: 45000,
  });
  await expect(page.getByRole("link", { name: "Экспорт CSV" })).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "AgentDesk Lab" }),
  ).toBeVisible();
});
test("mobile tabs keep search and source inspection usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_DEMO_PASSWORD!);
  await page.getByRole("button", { name: "Войти в лабораторию" }).click();
  await page.getByLabel("Ваш вопрос").fill("Сколько документов в Team?");
  await page.getByRole("button", { name: "Только поиск" }).click();
  await expect(page.locator(".diagnostics")).toBeVisible();
  await expect(page.locator(".diagnostics")).toContainText("AD-KB-08.01");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("offline search tab displays BM25 results and an empty vector channel", async ({ page }) => {
  const chunk = {
    id: "chunk-413",
    articleId: "AD-KB-09.03",
    title: "Ошибки документов",
    section: "Страница 28",
    content: "AD-413 означает, что файл больше предела тарифа.",
    filename: "AgentDesk_Knowledge.md",
    version: "markdown-v1",
    index: 0,
    checksum: "checksum-413",
    score: 3.1,
    bm25Score: 3.1,
    bm25Rank: 1,
    vectorScore: null,
    vectorRank: null,
    position: 1,
  };
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.route("**/api/auth/login", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/settings", (route) => route.fulfill({ json: {
    settings: { baseline: "base", strong: "strong", topK: 5, threshold: 0.18, semanticWeight: 0.7, temperature: 0.2, maxTokens: 1000, currency: "RUB", baselineInput: null, baselineOutput: null, strongInput: null, strongOutput: null, pricingDate: "2026-11-12" },
    keyConfigured: false,
    databaseConfigured: false,
  } }));
  await page.route("**/api/articles", (route) => route.fulfill({ json: { articles: [] } }));
  await page.route("**/api/evaluation/cases", (route) => route.fulfill({ json: { cases: [] } }));
  await page.route("**/api/search", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ question: "ошибка AD-413", offline: true });
    await route.fulfill({ json: {
      sources: [chunk], vectorResults: [], bm25Results: [chunk], overlapIds: [], offline: true,
    } });
  });
  await page.goto("/");
  await page.getByLabel("Пароль", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Войти в лабораторию" }).click();
  await page.getByRole("button", { name: "Поиск", exact: true }).click();
  await page.getByLabel("Запрос для поиска").fill("ошибка AD-413");
  await page.getByRole("button", { name: "Найти" }).click();
  await expect(page.getByRole("region", { name: "BM25" })).toContainText("AD-KB-09.03");
  await expect(page.getByRole("region", { name: "BM25" })).toContainText("BM25 3.100");
  await expect(page.getByRole("region", { name: "Векторный поиск" })).toContainText("Нет результатов");
  await expect(page.getByText("Векторный поиск отключён в автономном режиме.")).toBeVisible();
});

test("chat exposes three diagnostics panels for all four comparison modes", async ({
  page,
}) => {
  const source = {
    id: "chunk-ad413",
    articleId: "AD-KB-09.03",
    title: "Ошибки документов",
    section: "AD-413",
    content: "AD-413: файл больше предела тарифа.",
    filename: "AgentDesk_Knowledge.md",
    version: "version-checksum",
    index: 3,
    checksum: "chunk-checksum",
    score: 0.8,
    vectorScore: 0.872,
    bm25Score: 5.424,
    vectorRank: 1,
    bm25Rank: 1,
    position: 1,
  };
  const excluded = {
    ...source,
    id: "chunk-not-in-context",
    articleId: "DOC-ffffffffffff",
    title: "Другой результат поиска",
    section: "Не включён в контекст",
    content: "Этот результат найден, но не отправлялся модели.",
    vectorScore: 0.5,
    bm25Score: 0.9,
    vectorRank: 2,
    bm25Rank: 2,
    position: 2,
  };
  const historyId = "11111111-1111-4111-8111-111111111111";
  let chatCalls = 0;
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        settings: {
          baseline: "test/baseline",
          strong: "test/strong",
          topK: 5,
          threshold: 0.18,
          semanticWeight: 0.65,
          temperature: 0.2,
          maxTokens: 800,
          currency: "RUB",
          baselineInput: null,
          baselineOutput: null,
          strongInput: null,
          strongOutput: null,
          pricingDate: "",
        },
        keyConfigured: true,
        databaseConfigured: true,
      },
    }),
  );
  await page.route("**/api/articles", (route) =>
    route.fulfill({
      json: {
        articles: [
          {
            articleId: source.articleId,
            title: source.title,
            content: source.content,
          },
        ],
      },
    }),
  );
  await page.route("**/api/evaluation/cases", (route) =>
    route.fulfill({ json: { cases: [] } }),
  );
  await page.route("**/api/documents", (route) =>
    route.fulfill({ json: { documents: [] } }),
  );
  await page.route("**/api/evaluation/runs", (route) =>
    route.fulfill({ json: { runs: [] } }),
  );
  await page.route("**/api/chat/sessions", (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: historyId,
            preview: "Сохранённый вопрос AD-413",
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  await page.route(`**/api/chat/sessions/${historyId}`, (route) =>
    route.fulfill({
      json: {
        id: historyId,
        messages: [
          { role: "user", text: "Что означает AD-413?", result: null },
          {
            role: "assistant",
            text: "Сохранённый ответ AD-KB-09.03",
            result: {
              answer: "Сохранённый ответ AD-KB-09.03",
              model: "test/baseline",
              mode: "baseline-rag",
              sources: [source],
              retrieval: {
                vectorResults: [source],
                bm25Results: [source],
                overlapIds: [source.id],
                excludedFromContext: [],
              },
              llmContext: [
                {
                  id: source.id,
                  articleId: source.articleId,
                  title: source.title,
                  section: source.section,
                  content: source.content,
                  position: 1,
                  score: source.score,
                  vectorScore: source.vectorScore,
                  bm25Score: source.bm25Score,
                  vectorRank: source.vectorRank,
                  bm25Rank: source.bm25Rank,
                  filename: source.filename,
                  version: source.version,
                  index: source.index,
                },
              ],
              citations: [source.articleId],
              invalidCitations: [],
              latencyMs: 1,
              usage: null,
              cost: null,
              currency: "RUB",
              indexHash: "saved-index",
              status: "ok",
              pricingSnapshot: {},
            },
          },
        ],
      },
    }),
  );
  await page.route("**/api/chat", async (route) => {
    chatCalls++;
    const request = route.request().postDataJSON() as {
      role: "baseline" | "strong";
      rag: boolean;
    };
    const rag = request.rag;
    await route.fulfill({
      json: {
        answer: "**Результат проверки**",
        model: request.role,
        mode: `${request.role}-${rag ? "rag" : "plain"}`,
        sources: rag ? [source] : [],
        retrieval: {
          vectorResults: rag ? [source, excluded] : [],
          bm25Results: rag ? [source, excluded] : [],
          overlapIds: rag ? [source.id, excluded.id] : [],
          excludedFromContext: rag
            ? [
                {
                  id: excluded.id,
                  articleId: excluded.articleId,
                  title: excluded.title,
                  reason: "outside_top_k",
                },
              ]
            : [],
        },
        llmContext: rag
          ? [
              {
                id: source.id,
                articleId: source.articleId,
                title: source.title,
                section: source.section,
                content: source.content,
                position: 1,
                score: source.score,
                vectorScore: source.vectorScore,
                bm25Score: source.bm25Score,
                vectorRank: source.vectorRank,
                bm25Rank: source.bm25Rank,
                filename: source.filename,
                version: source.version,
                index: source.index,
              },
            ]
          : [],
        citations: rag ? [source.articleId] : [],
        invalidCitations: [],
        latencyMs: 10,
        usage: null,
        cost: null,
        currency: "RUB",
        indexHash: rag ? "test-index" : "without-rag",
        status: "ok",
        pricingSnapshot: {},
        sessionId: "test-session",
      },
    });
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Точные ответы начинаются со знаний." }),
  ).toBeVisible();
  const ragToggle = page.getByRole("checkbox", { name: "RAG включён" });
  for (const role of ["baseline", "strong"] as const) {
    await page.getByLabel("Модель").selectOption(role);
    for (const rag of [true, false]) {
      if ((await ragToggle.isChecked()) !== rag)
        await ragToggle.setChecked(rag);
      await page
        .getByLabel("Ваш вопрос")
        .fill(`${role} ${rag ? "RAG" : "plain"}`);
      await page.getByRole("button", { name: "Отправить →" }).click();
      const diagnostic = page.getByTestId("rag-diagnostics").last();
      await expect(diagnostic).toBeVisible();
      await expect(
        page.locator(".message.assistant .markdown strong").last(),
      ).toHaveText("Результат проверки");
      await diagnostic.locator(":scope > summary").click();
      if (rag) {
        await expect(diagnostic).toContainText("Векторный поиск (2)");
        await expect(diagnostic).toContainText("BM25 (2)");
        await expect(diagnostic).toContainText("Контекст LLM (1)");
        await expect(diagnostic).toContainText("Найдены обоими методами");
        await expect(diagnostic.locator(".rag-column").nth(0)).toContainText(
          "similarity 0.872",
        );
        await expect(diagnostic.locator(".rag-column").nth(1)).toContainText(
          "BM25 5.424",
        );
        const contextPanel = diagnostic.locator(".rag-column").nth(2);
        await expect(contextPanel).toContainText("ID chunk-ad413");
        await expect(contextPanel).toContainText("RRF 0.80000");
        await expect(contextPanel.locator(".source").first()).not.toContainText(
          "chunk-not-in-context",
        );
        await expect(contextPanel).toContainText("Исключено из контекста (1)");
        await expect(contextPanel).toContainText("за пределами top-K");
      } else {
        await expect(diagnostic).toContainText("Векторный поиск (0)");
        await expect(diagnostic).toContainText("BM25 (0)");
        await expect(diagnostic).toContainText("Контекст LLM (0)");
        await expect(diagnostic.getByTestId("rag-disabled").first()).toHaveText(
          "Поиск по базе знаний отключён.",
        );
      }
    }
  }
  await page.getByLabel("История чатов").selectOption(historyId);
  await expect(page.locator(".message.assistant").last()).toContainText(
    "Сохранённый ответ AD-KB-09.03",
  );
  const restoredDiagnostic = page.getByTestId("rag-diagnostics").last();
  await expect(restoredDiagnostic).toContainText("Диагностика RAG");
  expect(chatCalls).toBe(4);
  await page.getByRole("link", { name: source.articleId }).last().click();
  await expect(page.getByTestId("source-highlight")).toContainText(
    source.content,
  );
});

test("workflow completes all 60 retrieval questions after the browser tab is closed", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_EXECUTOR !== "workflow",
    "Workflow-specific background execution",
  );
  const context = page.context();
  await context.request.post("/api/auth/login", {
    data: { password: process.env.TEST_DEMO_PASSWORD },
  });
  await page.goto("/");
  const response = await context.request.post("/api/evaluation/runs", {
    data: { kind: "retrieval", split: "all", maxRequests: 0 },
  });
  expect(response.status()).toBe(201);
  const created = await response.json();
  expect(created.executor).toBe("workflow");
  await page.close();
  await expect
    .poll(
      async () =>
        (
          await (
            await context.request.get(`/api/evaluation/runs/${created.id}`)
          ).json()
        ).status,
      { timeout: 45000, intervals: [1500] },
    )
    .toBe("completed");
  const run = await (
    await context.request.get(`/api/evaluation/runs/${created.id}`)
  ).json();
  expect(run.completed).toBe(60);
  expect(run.results).toHaveLength(60);
  expect(run.references).toHaveLength(60);
  expect(run.snapshot).toBeUndefined();
  expect(run.leaseToken).toBeUndefined();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(
    reopened.getByRole("heading", {
      name: "Точные ответы начинаются со знаний.",
    }),
  ).toBeVisible();
});
