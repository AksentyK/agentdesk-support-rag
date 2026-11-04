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
  await page.getByRole("button", { name: "Диалог и поиск" }).click();
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

test("chat exposes real API diagnostics tabs for all four comparison modes", async ({
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
    route.fulfill({ json: { articles: [] } }),
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
  await page.route("**/api/chat", async (route) => {
    const request = route.request().postDataJSON() as {
      role: "baseline" | "strong";
      rag: boolean;
    };
    const rag = request.rag;
    await route.fulfill({
      json: {
        answer: "Результат проверки.",
        model: request.role,
        mode: `${request.role}-${rag ? "rag" : "plain"}`,
        sources: rag ? [source] : [],
        retrieval: {
          vectorResults: rag ? [source] : [],
          bm25Results: rag ? [source] : [],
          overlapIds: rag ? [source.id] : [],
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
      await diagnostic.locator("summary").click();
      await expect(diagnostic.getByTestId("rag-tab-vector")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      if (rag) {
        await expect(diagnostic).toContainText("Векторный поиск (1)");
        await expect(diagnostic).toContainText("BM25 (1)");
        await expect(diagnostic).toContainText("Контекст LLM (1)");
        await expect(diagnostic).toContainText("Найдены обоими методами");
        await diagnostic.getByTestId("rag-tab-bm25").click();
        await expect(
          diagnostic.getByTestId("rag-diagnostic-panel"),
        ).toContainText("BM25 5.424");
        await diagnostic.getByTestId("rag-tab-context").click();
        await expect(
          diagnostic.getByTestId("rag-diagnostic-panel"),
        ).toContainText("ID фрагмента: chunk-ad413");
      } else {
        await expect(diagnostic).toContainText("Векторный поиск (0)");
        await expect(diagnostic).toContainText("BM25 (0)");
        await expect(diagnostic).toContainText("Контекст LLM (0)");
        await expect(diagnostic.getByTestId("rag-disabled")).toHaveText(
          "Поиск по базе знаний отключён.",
        );
      }
    }
  }
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
