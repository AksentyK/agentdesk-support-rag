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
