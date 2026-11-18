# AgentDesk Support RAG Lab

Русскоязычный MVP AI-поддержки для **вымышленного** AgentDesk. Next.js 16 / React 19 / TypeScript / Tailwind CSS 4, PostgreSQL 17 + pgvector, Prisma 7 с JavaScript PostgreSQL-адаптером, серверный OpenAI SDK для RouterAI. Зависимости зафиксированы в `package-lock.json`; Node.js 24 LTS.

## Подготовка переноса на Vercel + Neon

Ветка `feat/agentdesk-ui-rag-v2`: аудит Vercel + Neon и переработка RAG-интерфейса. Vercel Workflow выполняет пакетные тесты; Docker Compose предназначен только для локальной разработки. Миграции и seed не запускаются во время Vercel build.

## Что реализовано

- Чат с историей сессии, экономичной/сильной моделью и переключателем RAG. Четыре режима используют одинаковые настройки генерации. Параметры и цены сохраняются в БД; model ID проверяются по `/models` перед сохранением и реальным вызовом. Недоступная модель не заменяется автоматически.
- Гибридный поиск: Qwen3 embeddings + exact pgvector cosine и BM25, объединённые через Reciprocal Rank Fusion (RRF) с удалением дублей и top-K. В diagnostics сохраняются отдельные списки, позиции, scores и фактический контекст LLM. Нет уверенных источников — локальный отказ без платного запроса.
- Проверка citation IDs на принадлежность найденным фрагментам. Неверные ID заменяются предупреждением, отдельно доступны в диагностике. **Проверка существования ссылки не доказывает, что каждое утверждение следует из источника.** Ответы без ссылок помечаются как неподтверждённые.
- Просмотр 35 встроенных статей; автономный поиск без БД/ключа. Импорт Markdown, загрузка MD/TXT/PDF/DOCX до 20 МБ, версии, checksum, переиндексация, удаление. Импорт повторяемый, старые версии исключены из поиска. PDF без текстового слоя отклоняется; OCR нет. Исходный PDF не импортируется вместе с Markdown.
- 60 вопросов, фиксированный стратифицированный split 48 dev / 12 holdout. Очередь в PostgreSQL, отдельный worker, до двух одновременных запросов, отмена между пакетами, повтор ошибок, CSV, метрики поиска/цитирования/отказов, usage, средняя и p95 задержка. Ручная оценка фактической точности и графики качества/времени/стоимости. Снимки настроек, индекса, набора и цен привязаны к прогону.
- Пароль без регистрации, подписанная HttpOnly/SameSite cookie на 12 часов, защита изменения данных от другого origin, ограничения запросов. Production API закрыт без `DEMO_ACCESS_PASSWORD`. Исходники и ключ RouterAI не передаются в браузер.

## Локальный запуск

```sh
npm ci
cp .env.example .env.local
```

#### Локальный запуск через Docker (Node.js на Mac не требуется)

Создайте `.env.local` в корне с `DATABASE_URL`, `DIRECT_URL`,
`DEMO_ACCESS_PASSWORD` и при необходимости `ROUTERAI_API_KEY`/моделями. Для
Docker Compose задайте `POSTGRES_PASSWORD` в корневом `.env`; пароль должен
совпадать с паролем в URL подключения. Compose сам направит контейнеры на хост
`db`, даже если в `.env.local` для запуска с Mac указан `localhost`.

```sh
docker compose up -d db
docker compose build web
docker compose run --rm web npm run db:migrate
docker compose run --rm web npm run db:seed
docker compose up -d web
```

Откройте <http://localhost:3000>. Для пакетных AI-тестов запустите отдельный
контейнер worker: `docker compose --profile worker up -d worker`. Если меняли
исходный код, пересоберите приложение: `docker compose build web worker` и
перезапустите сервисы. Не используйте production-пароли локально.

Для запуска из Node.js на хосте (Node 24) задайте локально `POSTGRES_PASSWORD`,
`DATABASE_URL` и пароль демонстрации в `.env.local`. Compose читает переменные отдельно:

```sh
# Задайте POSTGRES_PASSWORD в своей оболочке; не вставляйте реальный пароль в Git.
docker compose --env-file .env.local up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
# Во второй оболочке:
npm run worker
```

Откройте приложение на порту 3000. `dev` предназначен для доверенной локальной сети; в режиме development без пароля разрешён локальный интерфейс. Для любой публичной демонстрации используйте production с паролем и HTTPS.

Скрипты БД/worker читают `.env.local` с помощью Node `--env-file-if-exists`. Переменные, уже переданные процессу, имеют приоритет. Next.js читает `.env.local` самостоятельно. Для production:

```sh
npm run build
npm start
```

`npm start` запускает веб-сервер. В облаке пакетные тесты выполняются через Vercel Workflow. Живые процессы не переживают перезапуск среды. После рестарта worker помечает оставшийся `running` как `interrupted`; повтор ошибок выполняет только незавершённые/ошибочные пары вопрос/режим. Для MVP поддерживается **одна реплика**, один worker (advisory lock в PostgreSQL).

### RouterAI

В защищённых переменных окружения задайте:

- `ROUTERAI_API_KEY` — реальный ключ, только сервер.
- `ROUTERAI_BASE_URL=https://routerai.ru/api/v1`.
- `BASELINE_MODEL_ID`, `STRONG_MODEL_ID` — реальные ID из доступного вашему аккаунту каталога. Рекомендации из `CODEX_DECISIONS_V1.1.md` нужно проверить по актуальному каталогу; приложение не предполагает их доступность.
- `DEMO_ACCESS_PASSWORD` — уникальный пароль демо.

Без ключа нет имитации ответов: кнопка генерации отключена, API сообщает о недостающей настройке. В настройках можно загрузить каталог и выбрать ID; при 401/403/429/5xx выводятся безопасные сообщения. SDK retries отключены, чтобы не удваивать расходы скрыто. Health check не обращается к LLM. При неизвестных ценах/usage стоимость `null` («не рассчитано»), а не ноль. Ручные цены — за 1 млн токенов; дата/валюта сохраняются вместе с результатом.

При развёртывании за прокси можно задать `APP_ORIGIN` равным каноническому HTTPS origin приложения для строгой проверки источника запросов.

Для облачного окружения разрешите исходящий HTTPS к `routerai.ru` в его сетевых настройках. Этот PR не публикует среду и не меняет её сетевую политику.

### RouterAI neural embeddings

RouterAI embeddings were verified once by the operator: `Qwen/Qwen3-Embedding-8B`, 4096 dimensions. The endpoint is `https://routerai.ru/api/v1/embeddings`; set `ROUTERAI_API_KEY` only in the secret environment. The additive migration adds a dimension-flexible vector column and separate model, dimension and revision metadata while preserving legacy vectors and their hash. pgvector HNSW does not support 4096 dimensions; this MVP intentionally uses exact cosine search across the 35-chunk corpus. `npm run db:reindex-neural` defaults to a no-request dry run. A run makes one embedding request per missing chunk and persists that vector before requesting the next; existing vectors at the configured revision are skipped, and a PostgreSQL advisory lock prevents overlapping reindex runs. After a disconnect, rerun to continue from the first missing vector. A request whose response is lost before its vector is saved may need to be paid again, but this is bounded to one chunk. Execution requires `--execute`, `REINDEX_NEURAL_CONFIRM=YES`, a direct Neon URL, and exact `REINDEX_NEURAL_EXPECTED_HOST` and `REINDEX_NEURAL_EXPECTED_DATABASE` values. It also requires `NEON_ACTIVE_HOST` and refuses to run if the target host matches it. For isolated test-branch migrations, use `npm run db:migrate:test-neon` with `.env.test-neon`, `NEON_TEST_MIGRATION_CONFIRM=YES`, and exact `NEON_TEST_EXPECTED_HOST`/`NEON_TEST_EXPECTED_DATABASE` values; set `NEON_ACTIVE_HOST` so the script refuses the active branch host. The document reindex button also asks for explicit confirmation before making paid requests. Document import itself does not trigger paid indexing.

Rollback SQL is provided beside the migration as `rollback.sql`; it removes only the new neural columns and migration ledger row, leaving legacy vectors and source data intact. Apply no migration or rollback until the target database has been positively identified and a backup saved.

### Prisma и миграции

Для установки/сборки native Prisma engine не нужен: `scripts/generate.mjs` вызывает зафиксированный официальный генератор и WASM schema parser. `scripts/migrate.ts` применяет SQL в `prisma/migrations` через `pg`: advisory lock, транзакция на миграцию, checksum уже применённых файлов в `_agentdesk_migrations`. **Не используйте `prisma migrate deploy` для этой БД**: журнал здесь другой. Для изменения схемы обновляйте Prisma schema и добавляйте новую SQL-миграцию; не редактируйте применённые. Не отключайте TLS или проверку целостности пакетов. Для локальной БД нужен `CREATE EXTENSION vector`; для Neon проверьте наличие pgvector и права на `CREATE EXTENSION vector`.

## Проверки

```sh
npm run typecheck
npm test                    # без DATABASE_URL: 13 unit, 4 integration skipped
npm run test:retrieval       # только 48 dev; без ключа и без БД
npm run test:retrieval:db    # все 60, с сохранением результатов в отдельную тестовую БД
# С работающей БД и DATABASE_URL:
npm run db:migrate
npm run db:seed
npm test                    # 17 проверок, включая реальную pgvector БД и mock RouterAI
npm run build
npm run test:bundle          # PDF/DOCX из изолированного пакета после build
 npm run test:e2e:ui         # RAG tabs/history/Markdown, mock API, без БД и RouterAI
E2E_EXECUTOR=workflow npm run test:e2e # без отдельного worker
npm run test:e2e             # Chromium: пароль, поиск, документы, worker, мобильный интерфейс
```

Integration/e2e требуют **отдельную тестовую БД**, меняют её содержимое и сохраняют тестовые прогоны. E2E временно использует сгенерированный тестовый пароль и отключает ключ RouterAI; реальные платные вызовы в автоматических тестах не выполняются. Playwright использует системный `/usr/bin/chromium`, если он существует, иначе `npx playwright install chromium`; путь можно задать `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

`npm run test:retrieval -- --holdout` — отдельная финальная проверка, не использовать результаты для настройки промпта. UI не показывает holdout-эталоны до завершения выбранного прогона; worker никогда не передаёт эталоны в модель. После завершения эталоны доступны для ручной проверки. Для автоматического запуска всех 60 выберите «Все», а для сравнения — «Все 4 режима». Подтвердите до 240 платных запросов; денежный лимит установите у провайдера. При неизвестной цене приложение не может гарантировать денежный бюджет. Остановка не отменяет уже отправленные запросы.

Метрики: retrieval hit@k измеряется на вопросах с источником; корректность отказа — явно обозначенная текстовая эвристика, а не ground truth. Неподтверждённые ID фиксируются до фильтрации. Фактическая точность, полнота цитирования и отсутствие выдуманных утверждений требуют ручной проверки по эталону и источникам. График качества строится только по выставленным оценкам; неизвестные стоимость/качество не рисуются как ноль. Сильная модель не используется как эталон.

## Ограничения MVP

- RAG использует RouterAI Qwen3 4096D эмбеддинги и exact cosine search по небольшому корпусу. Наличие найденных фрагментов не означает наличие ответа; системная инструкция требует отказа без подтверждения. Проверка prompt injection и фактических отказов на реальных моделях остаётся обязательной перед публичным использованием. Старые LSA-векторы остаются только как сохраняемый legacy snapshot и не участвуют в поиске.
- Пароль демо общий: любой вошедший пользователь может менять документы/настройки и тратить разрешённый лимит. Изоляция сессий и тестов — по подписанной cookie; после нового входа старая история остаётся в БД, но не становится доступной новой сессии. Это не многопользовательский production-продукт с RBAC.
- Ограничение логина хранится в памяти одной реплики; остальные лимиты — в PostgreSQL. Для масштабирования нужны общий auth rate limiter, очередь и роли. Страницы HTML — оболочка приложения; данные и действия защищены серверным API.
- Документы извлекаются синхронно, до 200 PDF-страниц и 2 млн символов текста, DOCX с лимитом заявленной ZIP-распаковки. Нужны отдельный sandbox/parser worker и антивирус для работы с враждебными публичными загрузками. Не загружайте секреты: базовый детектор не гарантирует обнаружение всех форматов ключей.
- Для долгосрочного хранения/конфиденциальных данных добавьте retention/очистку истории и журналов, резервное копирование и отдельные права администратора.

Подробные требования: `CODEX_TECHNICAL_SPEC.md`, приоритетные решения: `CODEX_DECISIONS_V1.1.md`.
