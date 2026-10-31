# AgentDesk Support RAG Lab

Русскоязычный MVP AI-поддержки для **вымышленного** AgentDesk. Next.js 16 / React 19 / TypeScript / Tailwind CSS 4, PostgreSQL 17 + pgvector, Prisma 7 с JavaScript PostgreSQL-адаптером, серверный OpenAI SDK для RouterAI. Зависимости зафиксированы в `package-lock.json`; Node.js 24 LTS.

## Что реализовано

- Чат с историей сессии, экономичной/сильной моделью и переключателем RAG. Четыре режима используют одинаковые настройки генерации. Параметры и цены сохраняются в БД; model ID проверяются по `/models` перед сохранением и реальным вызовом. Недоступная модель не заменяется автоматически.
- Гибридный поиск: pgvector cosine + PostgreSQL FTS (`russian`) для кандидатов, ранжирование по семантическому/лексическому весу, точный приоритет AD-кодов. Настраиваются top-k, порог, вес. Нет уверенных источников — локальный отказ без платного запроса.
- Проверка citation IDs на принадлежность найденным фрагментам. Неверные ID заменяются предупреждением, отдельно доступны в диагностике. **Проверка существования ссылки не доказывает, что каждое утверждение следует из источника.** Ответы без ссылок помечаются как неподтверждённые.
- Просмотр 35 встроенных статей; автономный поиск без БД/ключа. Импорт Markdown, загрузка MD/TXT/PDF/DOCX до 20 МБ, версии, checksum, переиндексация, удаление. Импорт повторяемый, старые версии исключены из поиска. PDF без текстового слоя отклоняется; OCR нет. Исходный PDF не импортируется вместе с Markdown.
- 60 вопросов, фиксированный стратифицированный split 48 dev / 12 holdout. Очередь в PostgreSQL, отдельный worker, до двух одновременных запросов, отмена между пакетами, повтор ошибок, CSV, метрики поиска/цитирования/отказов, usage, средняя и p95 задержка. Ручная оценка фактической точности и графики качества/времени/стоимости. Снимки настроек, индекса, набора и цен привязаны к прогону.
- Пароль без регистрации, подписанная HttpOnly/SameSite cookie на 12 часов, защита изменения данных от другого origin, ограничения запросов. Production API закрыт без `DEMO_ACCESS_PASSWORD`. Исходники и ключ RouterAI не передаются в браузер.

## Локальный запуск

```sh
npm ci
cp .env.example .env.local
```

Задайте локально `POSTGRES_PASSWORD`, `DATABASE_URL` и пароль демонстрации в `.env.local`. Не используйте пароль из примеров в публичной среде. Compose читает переменные отдельно:

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
npm run start:railway
```

`start:railway` запускает веб-сервер и worker, завершает оба при сбое одного; требует БД и пароль. `npm start` запускает только веб-сервер. Живые процессы не переживают перезапуск среды. После рестарта worker помечает оставшийся `running` как `interrupted`; повтор ошибок выполняет только незавершённые/ошибочные пары вопрос/режим. Для MVP поддерживается **одна реплика**, один worker (advisory lock в PostgreSQL).

### RouterAI

В защищённых переменных окружения задайте:

- `ROUTERAI_API_KEY` — реальный ключ, только сервер.
- `ROUTERAI_BASE_URL=https://routerai.ru/api/v1`.
- `BASELINE_MODEL_ID`, `STRONG_MODEL_ID` — реальные ID из доступного вашему аккаунту каталога. Рекомендации из `CODEX_DECISIONS_V1.1.md` нужно проверить по актуальному каталогу; приложение не предполагает их доступность.
- `DEMO_ACCESS_PASSWORD` — уникальный пароль демо.

Без ключа нет имитации ответов: кнопка генерации отключена, API сообщает о недостающей настройке. В настройках можно загрузить каталог и выбрать ID; при 401/403/429/5xx выводятся безопасные сообщения. SDK retries отключены, чтобы не удваивать расходы скрыто. Health check не обращается к LLM. При неизвестных ценах/usage стоимость `null` («не рассчитано»), а не ноль. Ручные цены — за 1 млн токенов; дата/валюта сохраняются вместе с результатом.

При развёртывании за прокси можно задать `APP_ORIGIN` равным каноническому HTTPS origin приложения для строгой проверки источника запросов.

Для облачного окружения разрешите исходящий HTTPS к `routerai.ru` в его сетевых настройках. Этот PR не публикует среду и не меняет её сетевую политику.

### Локальные embeddings

`EMBEDDING_PROVIDER=local`, `EMBEDDING_MODEL=lsa-v1`, `EMBEDDING_DIMENSIONS=256` (пустые значения означают эти defaults). Отдельный адаптер `embed(text[]) -> number[][]` использует TF-IDF, русский Snowball stemming и SVD-проекцию LSA до 64 латентных координат, нормализацию и дополнение нулями до 256. Он обучается **только на текущих документах**, не на вопросах или эталонах. Это реальная локальная латентная семантическая модель, **не предобученная multilingual neural embedding model**; качество перефразировок и обнаружения неизвестных тем ограничено. Внешние веса и embedding API не нужны. Добавление/удаление/изменение документа пересчитывает векторы всего маленького корпуса атомарно; для большого корпуса нужен другой адаптер и отдельный pipeline.

Несовместимый provider/model/dimension вызывает ошибку. Hash адаптера хранится с каждым чанком; поиск отказывается работать с устаревшим индексом. Чанки сохраняют статью, заголовок, section, filename через документ, version checksum, индекс и checksum. Для произвольного документа без AD-KB ID создаётся `DOC-<hash>`; он тоже может цитироваться. Размер чанка — приближение по словам (~2 токена на русское слово), не точный токенизатор модели.

### Prisma и миграции

Для установки/сборки native Prisma engine не нужен: `scripts/generate.mjs` вызывает зафиксированный официальный генератор и WASM schema parser. `scripts/migrate.ts` применяет SQL в `prisma/migrations` через `pg`: advisory lock, транзакция на миграцию, checksum уже применённых файлов в `_agentdesk_migrations`. **Не используйте `prisma migrate deploy` для этой БД**: журнал здесь другой. Для изменения схемы обновляйте Prisma schema и добавляйте новую SQL-миграцию; не редактируйте применённые. Не отключайте TLS или проверку целостности пакетов. Для локальной БД нужен `CREATE EXTENSION vector`; на Railway выберите PostgreSQL-образ/шаблон с pgvector и соответствующими правами.

## Проверки

```sh
npm run typecheck
npm test                    # без DATABASE_URL: 12 unit, 2 integration skipped
npm run test:retrieval       # только 48 dev; без ключа и без БД
npm run test:retrieval:db    # все 60, с сохранением результатов в отдельную тестовую БД
# С работающей БД и DATABASE_URL:
npm run db:migrate
npm run db:seed
npm test                    # 14 проверок, включая реальную pgvector БД и mock RouterAI
npm run build
npm run test:e2e             # Chromium: пароль, поиск, документы, worker, мобильный интерфейс
```

Integration/e2e требуют **отдельную тестовую БД**, меняют её содержимое и сохраняют тестовые прогоны. E2E временно использует сгенерированный тестовый пароль и отключает ключ RouterAI; реальные платные вызовы в автоматических тестах не выполняются. Playwright использует системный `/usr/bin/chromium`, если он существует, иначе `npx playwright install chromium`; путь можно задать `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

`npm run test:retrieval -- --holdout` — отдельная финальная проверка, не использовать результаты для настройки промпта. UI не показывает holdout-эталоны до завершения выбранного прогона; worker никогда не передаёт эталоны в модель. После завершения эталоны доступны для ручной проверки. Для автоматического запуска всех 60 выберите «Все», а для сравнения — «Все 4 режима». Подтвердите до 240 платных запросов; денежный лимит установите у провайдера. При неизвестной цене приложение не может гарантировать денежный бюджет. Остановка не отменяет уже отправленные запросы.

Метрики: retrieval hit@k измеряется на вопросах с источником; корректность отказа — явно обозначенная текстовая эвристика, а не ground truth. Неподтверждённые ID фиксируются до фильтрации. Фактическая точность, полнота цитирования и отсутствие выдуманных утверждений требуют ручной проверки по эталону и источникам. График качества строится только по выставленным оценкам; неизвестные стоимость/качество не рисуются как ноль. Сильная модель не используется как эталон.

## Railway

### Existing project `acceptable-blessing` / `production`

Use the existing `agentdesk-web` service from branch `feat/agentdesk-rag-lab` and the existing `agentdesk-db` service from `pgvector/pgvector:pg17`. The database volume must remain mounted at `/var/lib/postgresql/data` (PostgreSQL 17). Do not create another project or database service. The image will repeatedly restart on an empty volume until `POSTGRES_PASSWORD` is set.

Configure these Railway variables in the service settings; enter secret values only in Railway, never in Git:

| Service | Variable | Value |
| --- | --- | --- |
| `agentdesk-db` | `POSTGRES_USER` | `agentdesk` |
| `agentdesk-db` | `POSTGRES_DB` | `agentdesk_rag` |
| `agentdesk-db` | `POSTGRES_PASSWORD` | New strong random URL-safe secret, such as 32 random hexadecimal bytes, generated and stored in Railway |
| `agentdesk-web` | `DATABASE_URL` | `postgresql://agentdesk:${{agentdesk-db.POSTGRES_PASSWORD}}@${{agentdesk-db.RAILWAY_PRIVATE_DOMAIN}}:5432/agentdesk_rag` using Railway reference variables; if the password contains reserved URL characters, URL-encode it instead |
| `agentdesk-web` | `DEMO_ACCESS_PASSWORD` | Separate strong client-facing password |
| `agentdesk-web` | `BASELINE_MODEL_ID` | Model ID confirmed in the RouterAI account |
| `agentdesk-web` | `STRONG_MODEL_ID` | Second confirmed model ID |
| `agentdesk-web` | `ROUTERAI_API_KEY` | RouterAI key; required only for real LLM calls |
| `agentdesk-web` | `ROUTERAI_BASE_URL` | `https://routerai.ru/api/v1` |
| `agentdesk-web` | `APP_ORIGIN` | Final `https://...up.railway.app` origin after creating a public domain; optional before that |

Railway's private-domain and secret reference syntax should be checked in the variable editor before saving `DATABASE_URL`. An alternative is to set `DATABASE_URL` to a Railway-provided database connection reference if it targets the `agentdesk-db` service and includes the intended database name. Never use `POSTGRES_HOST_AUTH_METHOD=trust` for this demo. No database public domain or TCP proxy is required.

The committed `railway.json` requests `npm ci && npm run build`, then runs `npm run db:migrate && npm run db:seed` as the pre-deploy command, and starts both the web process and evaluation worker with `npm run start:railway`. Verify these commands in the service settings if Railway does not pick up the config file. Once the DB reports a healthy start and the web deployment succeeds, create a public HTTPS domain for `agentdesk-web` and set `APP_ORIGIN` to its exact origin. Check `/api/health`: `app=ok`, `database=true`, `indexed=true`; `routerKeyConfigured` reports only key presence. Then test login, offline search for AD-413 and the Team limit, and one authorized real chat request for each configured model. Four-mode paid evaluations require a separate approved request limit.

1. Подключите репозиторий и этот PR после проверки. Приложение и PostgreSQL должны быть отдельными сервисами. Подключите persistent volume PostgreSQL; не используйте эфемерную БД.
2. Выберите PostgreSQL с pgvector. Задайте приложению приватный `DATABASE_URL`, пароль демо и при необходимости ключ/ID RouterAI. Для внешней БД используйте её корректный TLS/CA, не `rejectUnauthorized:false`.
3. `railway.json` задаёт сборку, pre-deploy миграции + идемпотентный импорт, старт приложения и worker, health endpoint. Node 24 закреплён в `engines`. `PORT` подставляется Railway. Одна реплика.
4. Проверьте `/api/health` (БД/индекс, без платных вызовов), вход, доступность статей, RAG-поиск AD-413 и лимита Team. Затем с отдельным разрешением на расход проверьте реальный чат обеих моделей и четыре режима. Только после этого считать публичный деплой проверенным.

В рамках разработки деплой на Railway и публикация облачной среды не выполняются.

## Ограничения MVP

- Локальная LSA на небольшом корпусе может вернуть похожие статьи для неизвестной функции. Наличие найденных фрагментов не означает наличие ответа; системная инструкция требует отказа без подтверждения. Проверка prompt injection и фактических отказов на реальных моделях остаётся обязательной перед публичным использованием.
- Пароль демо общий: любой вошедший пользователь может менять документы/настройки и тратить разрешённый лимит. Изоляция сессий и тестов — по подписанной cookie; после нового входа старая история остаётся в БД, но не становится доступной новой сессии. Это не многопользовательский production-продукт с RBAC.
- Ограничение логина хранится в памяти одной реплики; остальные лимиты — в PostgreSQL. Для масштабирования нужны общий auth rate limiter, очередь и роли. Страницы HTML — оболочка приложения; данные и действия защищены серверным API.
- Документы извлекаются синхронно, до 200 PDF-страниц и 2 млн символов текста, DOCX с лимитом заявленной ZIP-распаковки. Нужны отдельный sandbox/parser worker и антивирус для работы с враждебными публичными загрузками. Не загружайте секреты: базовый детектор не гарантирует обнаружение всех форматов ключей.
- Для долгосрочного хранения/конфиденциальных данных добавьте retention/очистку истории и журналов, резервное копирование и отдельные права администратора.

Подробные требования: `CODEX_TECHNICAL_SPEC.md`, приоритетные решения: `CODEX_DECISIONS_V1.1.md`.
