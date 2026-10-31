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
      "Документ для проверки загрузки и версий. Содержимое тестовое.",
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
