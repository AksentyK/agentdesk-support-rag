# Аудит и подготовка Vercel + Neon

Дата: 3 ноября 2026. Исходная `main`: `1727f0851c56a66758e5b4963dc5c8952584d235`.
Все изменения подготовлены в `feat/vercel-migration`. Эта работа не разворачивает
Vercel/Neon, не меняет Railway и не переносит действующую БД.

## Совместимость

| Компонент | Вывод и необходимое изменение |
| --- | --- |
| Next.js 16.4.3, React 19, Node 24 | Поддерживается Node.js runtime; Edge не подходит для pg, PDF/DOCX и LSA. Сборка остаётся `npm run build`. `start:railway` на Vercel не запускается. |
| Prisma 7.10.1 | JS PostgreSQL adapter уже используется, native query engine не нужен. Один PrismaClient на процесс, пул максимум 3 соединения, connection timeout 15 секунд, idle timeout 10 секунд. Singleton не является глобальным для всех Vercel instances. |
| Neon PostgreSQL | `DATABASE_URL`: TLS pooled endpoint `-pooler`; `DIRECT_URL`: прямой TLS endpoint той же БД для миграций. Session advisory lock мигратора и старого worker нельзя использовать через transaction pooler. Не отключать проверку TLS. |
| pgvector и RAG | Neon поддерживает `CREATE EXTENSION vector`, `vector(256)`, cosine `<=>`, русский FTS и транзакционные advisory locks. SQL и исходная миграция сохранены. Локальная LSA работает на CPU, без внешнего embedding API. Для 35 статей подходит; большие загруженные корпуса требуют замера CPU, памяти и времени переиндексации. |
| Ресурсы сборки | Markdown и JSON принудительно включены в file tracing API и Workflow. Во время build нет миграций, seed или обязательного обращения к RouterAI/БД. PDF/DOCX parsers остаются server external packages. PDF.js worker, fonts/cmaps/wasm и native canvas включены явно: автоматический tracing не обнаруживает все динамические зависимости PDF.js. |
| RouterAI | Серверный OpenAI-compatible SDK сохраняется, ключ не отправляется в браузер. SDK retries = 0. В Vercel timeout одного upstream-вызова ограничен 90 секундами: проверка каталога + completion должны поместиться в шаг вместе с RAG и записью результата. Каталог продолжает проверяться перед генерацией; startup-проверка на каждом Vercel cold start отключена. `/health` на Vercel может показывать `not-checked`: это не проверка доступности провайдера. |
| Авторизация и состояние | Подписанные cookies, CSRF/origin, PostgreSQL rate limits, настройки, история чата, документы и результаты сохраняются. `APP_ORIGIN` задаётся отдельно для production и preview. Не переносить корпоративный production origin в preview. |
| Документы до 20 МиБ | Тело запроса функции ограничено 4.5 MB. UI передаёт части по 3 МиБ в PostgreSQL, затем сервер собирает файл и использует прежние PDF/DOCX/MD/TXT проверки. Идентификатор загрузки привязан к session owner. Один временный файл на owner, TTL 30 минут; просроченные части удаляются при следующем начале загрузки. Постоянных оригиналов файлов на диске нет. Список документов возвращает metadata без полного текста. |
| Пакетные тесты | До 240 запросов нельзя помещать в одну Vercel Function. Перенесены на Workflow SDK 5.3.0: максимум две пары вопрос/режим в шаге, контрольная точка в PostgreSQL, затем durable sleep и следующий шаг. Все четыре режима, split 48/12, ручная оценка, отмена и CSV сохранены. |

Платформенные ограничения и источники проверены 3 ноября 2026:

- [Vercel Functions limits](https://vercel.com/docs/functions/limitations): Hobby/Fluid до 300 секунд, request/response body 4.5 MB. API задаёт 300 секунд; SDK задаёт максимальную допустимую платформой длительность Workflow handler.
- [Vercel Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing): Hobby один запуск в сутки; поэтому cron не выбран для интерактивной очереди.
- [Workflow + Next.js](https://workflow-sdk.dev/docs/getting-started/next): `withWorkflow`, серверный `start`, durable steps.
- [Workflow pricing](https://vercel.com/docs/workflows/pricing): Hobby имеет включённые квоты; compute и Queues учитываются отдельно. Бесплатность всех будущих прогонов не гарантируется. Перед активацией проверить текущие квоты, назначение Hobby, ограничения расходов и тариф аккаунта. Платный план не подключать без согласования.
- [Neon pgvector](https://neon.com/docs/extensions/pgvector), [Neon pooling](https://neon.com/docs/connect/connection-pooling).

Доступность RouterAI из конкретного региона Vercel, Neon TLS/pooler и ограничения
аккаунта требуют проверки в preview. Локальные тесты не доказывают эту доступность.
Регион Vercel нужно выбрать рядом с Neon и проверить задержки RouterAI.

## Архитектура и выполнение тестов

```mermaid
flowchart LR
  Browser[Браузер] --> Web[Vercel Next.js Node runtime]
  Web --> DB[(Neon PostgreSQL + pgvector)]
  Web --> AI[RouterAI]
  Web --> Workflow[Vercel Workflow / управляемая очередь]
  Workflow --> Batch[Шаг: до двух тестовых запросов]
  Batch --> AI
  Batch --> DB
  Batch --> Workflow
```

`EVALUATION_EXECUTOR=workflow` включает Workflow. На Vercel это default и
единственный допустимый исполнитель; локально и на Railway default — `worker`.
Standalone worker выбирает только записи `executor=worker`; Workflow — только
`executor=workflow`. Старые Railway startup/config сохранены.

API сохраняет snapshot в БД и вызывает `await start(evaluationWorkflow, [id])`.
Запуск не зависит от открытого браузера. В Workflow передаются только ID и номера
пакетов, ответы и эталоны хранятся в PostgreSQL. Сгенерированные внутренние
handlers защищаются платформой Vercel Queues; не переносить local World в
публичное production окружение.

DB row lock + номер пакета + lease предотвращают повторный запуск одного пакета.
Результат и счётчик прогресса сохраняются одной транзакцией. Успешно сохранённый
пакет при повторной доставке пропускается. Workflow step `maxRetries=0` и SDK
RouterAI `maxRetries=0`: неоднозначный платный запрос не повторяется автоматически.
Если worker потерян после отправки запроса до записи результата, нельзя доказать,
списал ли провайдер деньги. Явный повтор такого теста может повторно тарифицироваться.

Lease выполнения — 6 минут, ожидания/доставки — 10 минут. API при чтении тестов
или работе с документами переводит просроченные Workflow jobs в `interrupted`.
Поздние результаты старого lease не записываются. Пользователь может отменить
прогон и явно повторить ошибки/неоконченные пары. Отмена проверяется перед каждым
пакетом; уже отправленные запросы завершатся. Закрытие вкладки не отменяет тест.

## Подготовка preview (после согласования ресурсов)

1. Создать отдельную Neon БД/ветку PostgreSQL 17 с pgvector, выбрав согласованный
   бесплатный вариант либо отдельно согласовав платный тариф. Не подключать
   действующий Railway DATABASE_URL к Vercel.
2. В Vercel импортировать эту feature-ветку как изолированный preview. Node 24,
   Fluid Compute включён, build `npm run build`, без custom start command.
   Не включать автоматический deploy Railway из feature-ветки.
3. Настроить серверные переменные для preview: pooled `DATABASE_URL`,
   `DEMO_ACCESS_PASSWORD`, `APP_ORIGIN`, `EVALUATION_EXECUTOR=workflow`, параметры
   embeddings/RAG. Для модели — существующие согласованные RouterAI key и IDs,
   цены/валюта/дата. Не передавать ключи с префиксом `NEXT_PUBLIC_`.
   В Vercel включить доступ к системным переменным (`VERCEL_DEPLOYMENT_ID`
   требуется SDK). `WORKFLOW_TARGET_WORLD` в Vercel оставить незаданным.
4. `DIRECT_URL` нужен оператору миграции; его необязательно хранить в runtime Vercel.
   Из доверенной среды с переменными **новой тестовой БД** выполнить:
   `npm ci`, `npm run db:migrate`, `npm run db:seed`. Новый seed сохраняет 35 статей
   и 60 вопросов, но не восстанавливает историю действующего приложения.
   Не запускать seed/миграции в build: previews не должны менять общую production БД.
5. Проверить пароль, CSRF, `/api/health`, 35 статей, поиск AD-413 и лимит Team,
   upload PDF/DOCX/MD/TXT (включая файл больше 4.5 MB), удаление/переиндексацию,
   retrieval-run и CSV, отмену и повтор. Закрыть вкладку во время теста и проверить
   завершение после открытия. Отдельно проверить прерывание и истечение lease.
6. Проверить RouterAI `/models` из preview. Реальные генерации и сравнение
   240 запросов выполнять только с согласованным лимитом расходов; автоматические
   проверки используют mock и не расходуют баланс RouterAI.

Локальная проверка Workflow без внешних сервисов:

```sh
npm run build
# DATABASE_URL должен указывать на отдельную тестовую БД с миграциями и seed.
EVALUATION_EXECUTOR=workflow WORKFLOW_TARGET_WORLD=local npm start
# Или весь browser suite без отдельного worker:
E2E_EXECUTOR=workflow npm run test:e2e
```

Local World хранит служебное состояние в `.workflow-data/` и подходит для тестов,
но не заменяет устойчивое хранилище Vercel в production.

## Перенос действующих данных — отдельный этап после разрешения

Сейчас этот этап НЕ выполнен. Railway, его БД, настройки, домен и deployment
остаются действующими. Для согласованного окна переноса потребуется остановить
новые записи/AI-прогоны на источнике, дождаться текущих запросов и получить
консистентный полный dump. Пока источник продолжает принимать записи, ранний
snapshot нельзя считать финальным переносом без потерь.

1. Сохранить полный `pg_dump --format=custom --no-owner --no-acl` из Railway
   в защищённом месте (не Git). Доступ только на чтение; экспорт не удаляет данные.
   Сохранить версии PostgreSQL/pgvector и дату снимка. Проверить backup восстановлением
   в отдельную БД. Не открывать TCP proxy и не менять Railway без отдельного разрешения.
2. Восстановить dump через `pg_restore --exit-on-error --no-owner --no-acl`
   **только в пустую целевую Neon БД**, без `--clean`. Не выполнять `db:seed`
   перед восстановлением. Переносятся документы, версии, chunks и векторы,
   настройки/цены, вопросы, чаты, результаты/ручные оценки и журнал
   `_agentdesk_migrations`. Seed сам по себе не переносит эти данные.
3. Применить добавочную миграцию `npm run db:migrate` с `DIRECT_URL` целевой Neon.
   Не использовать `prisma migrate deploy`: здесь собственный журнал миграций.
4. Сравнить исходный snapshot и цель до новых записей/HTTP-проверок:

   ```sh
   # Переменные задаются защищённо; скрипт не печатает URLs или содержимое строк.
   # SOURCE_DATABASE_URL — источник snapshot; TARGET_DIRECT_URL — копия в Neon.
   npm run db:verify-migration
   ```

   Скрипт выполняет READ ONLY транзакции и сравнивает количество и SHA-256 строк
   всех 11 исходных таблиц, включая vector и ручные оценки. Новые поля исполнителя
   исключены из сравнения, служебные таблицы загрузки/миграций не сравниваются.
   Любое расхождение завершает команду с ошибкой. При непрерывной записи источника
   сравнение с живой БД не заменяет сравнение с финальным snapshot.
5. После успешного сравнения пометить **только в целевой копии** старые незавершённые
   worker jobs как `interrupted`, не удаляя результаты:

   ```sql
   UPDATE "EvaluationRun" SET status = 'interrupted'
   WHERE executor = 'worker' AND status IN ('queued', 'running');
   ```

   Они не запускаются автоматически. В UI можно явно повторить оставшиеся пары.
6. Провести preview smoke tests на целевой БД. Production domain/маршрутизация,
   окончательное переключение и merge выполняются только после отдельного разрешения.

## Откат

До переключения Railway продолжает обслуживать пользователей. Если preview не
проходит проверки, исправить feature-ветку; исходную БД не менять. При проблемах
после согласованного переключения возвращать трафик на Railway только по
утверждённому плану. Если Neon уже принимал записи, сначала сохранить их и
согласовать обратный перенос/сверку: простое возвращение к старому snapshot
потеряет новые данные. Ни БД Railway, ни backup не удаляются этим PR.

## Ограничения готовности

Код и локальные проверки готовят миграцию, но не подтверждают production cutover.
Остаются: согласование ресурсов/лимитов, реальный preview Vercel+Neon, проверка
RouterAI из региона, полный экспорт/сверка данных и разрешение переключения.
Временные upload parts занимают место Neon до lazy cleanup; для большего объёма
нужно отдельно обсудить object storage и фоновый импорт. LSA переиндексирует весь
корпус в транзакции до 120 секунд, поэтому произвольный большой корпус не имеет
гарантии по Vercel CPU/memory/time limits.
