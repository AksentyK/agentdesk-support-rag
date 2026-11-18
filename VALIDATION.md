# Vercel migration validation — 2026-11-03

Validated in a new managed environment against current main `1727f0851c56a66758e5b4963dc5c8952584d235`, using an isolated local PostgreSQL 17/pgvector container. Railway, its database and deployment configuration were not changed. No Vercel/Neon account, deployment or paid service was provisioned.

- `npm run typecheck` and `npm run build`: passed with Next.js 16.4.3, Prisma 7.10.1 and Workflow SDK 5.3.0. Build runs without a database or RouterAI credentials.
- `npm test`: **17 passed, 0 failed, 0 skipped** with the isolated database. Includes all 240 question/mode combinations against mock RouterAI, duplicate batch delivery without duplicate AI requests, atomic progress, cancellation, stale/uncertain leases, explicit partial retry, upload ownership/expiry/part validation, a 5.1 MB file, and real PDF/DOCX extraction.
- `npm run test:bundle`: passed. API trace **76 MiB**, Workflow trace **75 MiB**, below the standard 250 MB limit. Both include all knowledge/test data. PDF/DOCX parsers work in an isolated temporary directory containing only traced dependencies; PDF.js worker and native canvas are explicitly included.
- `E2E_EXECUTOR=workflow npm run test:e2e`: **3 passed** in Chromium against the production build, with no standalone worker. Includes a complete 60-question run after closing the browser tab and reopening the app, plus password/CSRF, large chunked upload/delete, persisted evaluation/CSV visibility and mobile search.
- `npm run test:e2e`: **2 passed, 1 intentionally skipped** (the Workflow-only tab-closure test), against the preserved standalone worker path. Large chunked upload also passes in this mode.
- `npm run test:retrieval` and `npm run test:retrieval:db`: passed; all 60 database operations completed. Source hits unchanged: dev 38/42, holdout 10/10. All 8 out-of-scope questions still retrieve fragments. These are existing false positives; no prompt or retrieval tuning was performed.
- Additive migration tested on a restored copy of the **original schema**, populated with local application data: all 11 original tables matched by count and row SHA-256 after upgrade, including 35 chunks, 60 questions, 16 runs and 940 results. A deliberately removed test question in the isolated target was detected, returning exit code 1. The source and production Railway were not modified by this verification.
- Git diff confirms the original Markdown, PDF, JSON/CSV/XLSX datasets, initial migration, `railway.json` and Railway startup script are unchanged.

Unverified until an approved preview exists: Vercel deployment/queue delivery, Neon pooled TLS and database extension permissions, RouterAI reachability/model availability from the selected region, actual full production database transfer, plan quotas and paid inference. Local World demonstrates the Workflow HTTP integration but does not reproduce every Vercel platform behavior. The existing retrieval accuracy limitations remain. No real paid model calls were made.

See [audit and migration runbook](docs/VERCEL_MIGRATION.md). The historical report below belongs to the original implementation and is retained for context; GitHub CI status is reported separately on the migration PR.

---

# Validation — 2026-10-30

Validated locally in the managed development machine; Railway was not deployed.

- Clean `npm ci` succeeded with the committed lockfile and official WASM/JS Prisma generation path.
- `npm run build` succeeded (Next.js 16.4.3 production build, including TypeScript).
- `npm test` with a dedicated PostgreSQL 17 / pgvector database: **14 passed, 0 failed, 0 skipped**. Includes idempotent import, real cosine/FTS retrieval, durable 48-question evaluation, and a clearly labelled mock HTTP RouterAI server covering four modes, usage/cost and 401/429/500 errors. Mock keys and model IDs are test fixtures, not real credentials or successful production inference.
- `npm run test:e2e`: **2 passed** in system Chromium against the production server and evaluation worker. Covers password access, unauthenticated API denial, cross-origin denial, Russian UI, AD-413/Team search, file upload/delete, persisted 48-question run, omission of private snapshot in API responses, mobile layout and logout.
- `npm run db:migrate` succeeded twice; second execution was a no-op. Initial knowledge import was also repeated without duplicate documents/chunks.
- `npm run test:retrieval:db`: **60 operations completed**, 0 operation failures. Dev: 38/42 source-bearing questions hit@5 (90.5%); holdout: 10/10 (100%). Aggregate 48/52 (92.3%). **All 8 out-of-scope questions still retrieved fragments** (6 dev, 2 holdout); these are retrieval false positives, not successful answers. No prompt or retrieval tuning followed the final holdout measurement.

Final retrieval corpus checksum: `fc17e82affbd80957c9120797ac682e5c02c163e9ce5a3e0270a820c0e5da7e2`.
Dataset/split checksum: `3d78e4ee27e331a0c6546e8b44256d1d2d360bdbec05b33d67df10339cac9e4f`.

Not verified: real RouterAI model availability, real generation accuracy, real-model prompt-injection resistance/refusals, actual usage/prices, Railway public access or deployment. No RouterAI API key was available. No paid model calls were performed. The UI keeps unknown quality/cost separate from zero and supports manual reference-based scoring after a run.

The committed GitHub Actions workflow has not yet run on GitHub; local results above are independent of it. API credentials/passwords were not saved in the repository. GitHub API access returned `Forbidden` in this environment, independently of successful native Git access.
